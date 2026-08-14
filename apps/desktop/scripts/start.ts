/**
 * Launches the desktop app. On macOS this does not run `electron .` against
 * the stock Electron.app: that bundle's Info.plist is named "Electron", and
 * that is what the menu bar and dock display. `app.setName` cannot override
 * it. Packaged builds already get `productName: brevi` from electron-builder.
 *
 * For a source launch we clone Electron.app to build/dev-app/brevi.app
 * (copy-on-write on APFS), retitle the plist, swap in the brevi logo as
 * the bundle icon, ad-hoc sign the copy, and exec that binary instead.
 * Linux has no .app bundle, so it just runs the electron binary.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "brevi";
/** Separate from the packaged id (`dev.brevi.desktop`) so Launch Services does not mix a source launch with an installed build. */
const DEV_BUNDLE_ID = "dev.brevi.desktop.dev";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const DEV_DIR = resolve(APP_ROOT, "build", "dev-app");
const DEV_APP = resolve(DEV_DIR, `${APP_NAME}.app`);
const LOGO_PNG = resolve(APP_ROOT, "assets", "icon.png");
const DEV_ICNS = resolve(DEV_DIR, "icon.icns");
const BUNDLE_ICNS = "icon.icns";

function electronBinary(): string {
  const require = createRequire(import.meta.url);
  return require("electron") as string;
}

function plistString(plist: string, key: string): string | null {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function replacePlistString(plist: string, key: string, value: string): void {
  execFileSync("plutil", ["-replace", key, "-string", value, plist]);
}

/** Path of the Electron.app that the `electron` package would launch. */
function stockMacApp(binary: string): string {
  return resolve(binary, "..", "..", "..");
}

/** Build a multi-resolution .icns from assets/icon.png via sips + iconutil. */
function ensureDevIcns(): void {
  if (
    existsSync(DEV_ICNS) &&
    existsSync(LOGO_PNG) &&
    statSync(DEV_ICNS).mtimeMs >= statSync(LOGO_PNG).mtimeMs
  ) {
    return;
  }
  const iconset = resolve(DEV_DIR, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const slices: Array<[number, string]> = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [px, name] of slices) {
    execFileSync("sips", ["-z", String(px), String(px), LOGO_PNG, "--out", join(iconset, name)], {
      stdio: "pipe",
    });
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", DEV_ICNS], { stdio: "pipe" });
  rmSync(iconset, { recursive: true, force: true });
}

function refreshDevApp(sourceApp: string): void {
  const sourcePlist = resolve(sourceApp, "Contents", "Info.plist");
  const destPlist = resolve(DEV_APP, "Contents", "Info.plist");
  const destIcon = resolve(DEV_APP, "Contents", "Resources", BUNDLE_ICNS);
  const sourceVersion = plistString(sourcePlist, "CFBundleShortVersionString");
  const destVersion = existsSync(destPlist) ? plistString(destPlist, "CFBundleShortVersionString") : null;
  const destName = existsSync(destPlist) ? plistString(destPlist, "CFBundleName") : null;
  const destId = existsSync(destPlist) ? plistString(destPlist, "CFBundleIdentifier") : null;
  const destIconFile = existsSync(destPlist) ? plistString(destPlist, "CFBundleIconFile") : null;
  const destIconFresh =
    existsSync(destIcon) &&
    existsSync(LOGO_PNG) &&
    statSync(destIcon).mtimeMs >= statSync(LOGO_PNG).mtimeMs;

  if (
    existsSync(DEV_APP) &&
    destVersion === sourceVersion &&
    destName === APP_NAME &&
    destId === DEV_BUNDLE_ID &&
    destIconFile === BUNDLE_ICNS &&
    destIconFresh
  ) {
    return;
  }

  if (!existsSync(DEV_APP) || destVersion !== sourceVersion) {
    rmSync(DEV_APP, { recursive: true, force: true });
    mkdirSync(dirname(DEV_APP), { recursive: true });
    try {
      execFileSync("cp", ["-cR", sourceApp, DEV_APP]);
    } catch {
      execFileSync("cp", ["-R", sourceApp, DEV_APP]);
    }
  }

  replacePlistString(destPlist, "CFBundleName", APP_NAME);
  replacePlistString(destPlist, "CFBundleDisplayName", APP_NAME);
  replacePlistString(destPlist, "CFBundleIdentifier", DEV_BUNDLE_ID);

  if (!existsSync(LOGO_PNG)) {
    console.error(`✖ brevi logo not found at ${LOGO_PNG}`);
    process.exit(1);
  }
  mkdirSync(DEV_DIR, { recursive: true });
  ensureDevIcns();
  cpSync(DEV_ICNS, destIcon);
  replacePlistString(destPlist, "CFBundleIconFile", BUNDLE_ICNS);

  // Changing the plist or icon breaks the stock Electron signature; Apple
  // Silicon will refuse to launch an invalidly signed bundle.
  execFileSync("codesign", ["--force", "--sign", "-", DEV_APP]);
}

function launch(binary: string): void {
  const child = spawn(binary, [".", ...process.argv.slice(2)], {
    cwd: APP_ROOT,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

const binary = electronBinary();
if (process.platform === "darwin") {
  const sourceApp = stockMacApp(binary);
  if (!existsSync(sourceApp)) {
    console.error(`✖ Electron.app not found at ${sourceApp}`);
    process.exit(1);
  }
  refreshDevApp(sourceApp);
  launch(resolve(DEV_APP, "Contents", "MacOS", "Electron"));
} else {
  launch(binary);
}

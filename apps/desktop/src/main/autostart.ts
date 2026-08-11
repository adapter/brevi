import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

// Electron implements login items on macOS and Windows only; Linux needs a
// standard XDG autostart entry instead (see freedesktop.org's Desktop Entry
// Specification, "Autostart Directories").
const LINUX_AUTOSTART_DIR = join(homedir(), ".config", "autostart");
const LINUX_AUTOSTART_PATH = join(LINUX_AUTOSTART_DIR, "brevi.desktop");

/**
 * Passed by the Linux autostart entry so a login launch is recognisable.
 * macOS reports one through the login item's own state; XDG autostart has no
 * equivalent, so the flag we wrote into Exec= is the signal.
 */
const LINUX_AUTOSTART_FLAG = "--opened-at-login";

/** The executable to relaunch: the AppImage itself when running from one, otherwise Electron's own binary. */
function launcherPath(): string {
  return process.env.APPIMAGE ?? process.execPath;
}

function quoteIfNeeded(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

function desktopEntry(): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=brevi",
    `Exec=${quoteIfNeeded(launcherPath())} ${LINUX_AUTOSTART_FLAG}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Whether brevi is registered to start at login. */
export function launchAtLoginEnabled(): boolean {
  try {
    if (process.platform === "darwin") return app.getLoginItemSettings().openAtLogin;
    if (process.platform === "linux") return existsSync(LINUX_AUTOSTART_PATH);
  } catch {
    // Fall through to false.
  }
  return false;
}

/**
 * True when the login item started this launch rather than the user. Such a
 * launch is registered with openAsHidden on macOS and is meant to land in the
 * menu bar, so the window must not put itself on screen.
 */
export function openedAtLogin(): boolean {
  try {
    if (process.platform === "darwin") {
      const settings = app.getLoginItemSettings();
      return settings.wasOpenedAtLogin || settings.wasOpenedAsHidden;
    }
    if (process.platform === "linux") return process.argv.includes(LINUX_AUTOSTART_FLAG);
  } catch {
    // Fall through to false: a launch we cannot classify is treated as the
    // user's own, since showing an unwanted window beats hiding a wanted one.
  }
  return false;
}

/** Register or unregister brevi as a login item. */
export function setLaunchAtLogin(enabled: boolean): void {
  try {
    if (process.platform === "darwin") {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    } else if (process.platform === "linux") {
      if (enabled) {
        mkdirSync(LINUX_AUTOSTART_DIR, { recursive: true });
        writeFileSync(LINUX_AUTOSTART_PATH, desktopEntry());
      } else if (existsSync(LINUX_AUTOSTART_PATH)) {
        unlinkSync(LINUX_AUTOSTART_PATH);
      }
    }
    // Windows is out of scope for the project; nothing to do there.
  } catch {
    // A read-only home (or a locked-down profile on macOS) must not crash the app.
  }
}

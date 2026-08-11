import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

// Electron implements login items on macOS and Windows only; Linux needs a
// standard XDG autostart entry instead (see freedesktop.org's Desktop Entry
// Specification, "Autostart Directories").
const LINUX_AUTOSTART_DIR = join(homedir(), ".config", "autostart");
const LINUX_AUTOSTART_PATH = join(LINUX_AUTOSTART_DIR, "brevi.desktop");

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
    `Exec=${quoteIfNeeded(launcherPath())}`,
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

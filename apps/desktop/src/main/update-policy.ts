// Pure decision logic for the auto-updater: no `electron` import, so it can
// be unit tested under plain bun (see the note at the top of summary.ts).
// updater.ts owns the electron-updater wiring and asks these functions what
// to show and what to do; tray.ts renders the results.

/** Where the updater is in its cycle; rendered by the tray and driven by updater.ts. */
export type UpdaterState =
  | { kind: "unsupported"; reason: string }
  | { kind: "idle"; lastCheckedAt?: number } // Date.now() of the last completed check
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string; busyRuns: number } // downloaded, waiting to install
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

export interface UpdateEnvironment {
  platform: NodeJS.Platform; // process.platform
  packaged: boolean; // app.isPackaged
  appImage: boolean; // Boolean(process.env.APPIMAGE)
}

export type UpdateSupport = { supported: true } | { supported: false; reason: string };

/**
 * Whether this install can even ask for updates. electron-updater works by
 * downloading a new build and swapping it in for the running one, which only
 * makes sense for a self-contained artifact: on macOS that's the .app
 * bundle, on Linux it's an AppImage (electron-updater can replace one in
 * place because it's just a single file). A deb or rpm install is owned by
 * dpkg/rpm, tracked in the system package database and laid out across
 * /usr/*; self-updating it from inside the app would fight the package
 * manager, so those installs are left to `apt`/`dnf` instead. Development
 * builds (`packaged: false`) are excluded outright, there is nothing to
 * replace them with.
 */
export function updateSupport(env: UpdateEnvironment): UpdateSupport {
  if (!env.packaged) return { supported: false, reason: "disabled in development builds" };
  if (env.platform === "darwin") return { supported: true };
  if (env.platform === "linux") {
    if (env.appImage) return { supported: true };
    return { supported: false, reason: "managed by your package manager (deb/rpm)" };
  }
  return { supported: false, reason: `unsupported on ${env.platform}` };
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** Tray header line summarizing update status, or null to show nothing (the common case: idle). */
export function updateLine(state: UpdaterState): string | null {
  switch (state.kind) {
    case "unsupported":
      return `Updates: ${state.reason}`;
    case "idle":
      return null;
    case "checking":
      return "Update: checking...";
    case "downloading":
      return `Update: downloading v${state.version} (${clampPercent(state.percent)}%)`;
    case "ready":
      if (state.busyRuns === 0) return `Update: v${state.version} ready, restarting shortly`;
      return `Update: v${state.version} ready (waiting for ${state.busyRuns} run${state.busyRuns === 1 ? "" : "s"})`;
    case "installing":
      return `Update: installing v${state.version}...`;
    case "error":
      return `Update: check failed (${state.message})`;
    default:
      return null;
  }
}

/** Label and enabled state for the tray's "Check for Updates" menu entry. */
export function updateMenuItem(state: UpdaterState): { label: string; enabled: boolean } {
  switch (state.kind) {
    case "unsupported":
      return { label: "Check for Updates", enabled: false };
    case "checking":
      return { label: "Checking for Updates...", enabled: false };
    case "downloading":
      return { label: `Downloading v${state.version}...`, enabled: false };
    case "ready":
      return { label: `Restart to Update (v${state.version})`, enabled: true };
    case "installing":
      return { label: "Restarting...", enabled: false };
    case "idle":
    case "error":
      return { label: "Check for Updates", enabled: true };
    default:
      return { label: "Check for Updates", enabled: true };
  }
}

/** What clicking the tray's update menu item should do, given the current state. */
export function updateAction(state: UpdaterState): "install" | "check" | "none" {
  if (state.kind === "ready") return "install";
  if (state.kind === "idle" || state.kind === "error") return "check";
  return "none";
}

/**
 * Whether it's safe to restart into the downloaded update right now.
 * "busy" deliberately excludes queued and waiting runs: a queued run hasn't
 * started yet (a restart just delays it a few seconds), and a waiting run is
 * parked on a human's input (it isn't going anywhere while nobody's typing),
 * so neither is lost by restarting. A run the orchestrator is actually
 * executing locally is what would be lost, so only that counts as busy.
 */
export function shouldInstallNow(state: UpdaterState, busyRuns: number): boolean {
  return state.kind === "ready" && busyRuns === 0;
}

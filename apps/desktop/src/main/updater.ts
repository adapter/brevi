// Wires electron-updater into the app. electron-updater is what actually
// downloads and applies an update; this module decides when to check, when
// to download, and when it's safe to restart into what was downloaded, using
// the pure decision logic in update-policy.ts and the persisted bookkeeping
// in update-state.ts.
//
// The feed is the generic static feed configured in electron-builder.yml: a
// plain directory of files (the release's app-update.yml plus the platform
// artifacts) that electron-updater polls over HTTP. `app-update.yml` is baked
// into the packaged app at build time and tells electron-updater where that
// feed lives; there's nothing to configure here. Staged rollout (only
// offering an update to some fraction of installs) is a publisher-side knob,
// `stagingPercentage` in the published channel file, which electron-updater
// reads and honours per machine on its own; this module never needs to know
// what percentage it's in.
//
// Everything about a failed install and quarantining a bad version lives in
// update-state.ts; this module only calls into it at the right moments.
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import {
  shouldInstallNow,
  updateSupport,
  type UpdaterState,
} from "./update-policy.js";
import {
  isQuarantined,
  markInstallStarted,
  readUpdateState,
  reconcile,
  writeUpdateState,
} from "./update-state.js";

/** Let the orchestrator finish coming up before the first check competes with it for the network/CPU. */
const FIRST_CHECK_DELAY_MS = 30_000;
/** Four checks a day, so an install picks a release up well inside a day even if the app is only idle briefly. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** electron's own notification body can run long; keep the tray line readable. */
const MAX_ERROR_MESSAGE_LENGTH = 120;

export interface DesktopUpdaterOptions {
  /** app.getVersion(): the running version, compared against a pending install on launch. */
  currentVersion: string;
  /** Runs a restart would disrupt (executing or queued); an automatic install must wait for these. */
  busyRuns: () => number;
  onState: (state: UpdaterState) => void;
  /** An update finished downloading and will apply on the next safe restart. */
  onUpdateReady?: (version: string) => void;
  /** A previous install did not take: the app came back up on the old version. */
  onRollback?: (version: string) => void;
  /** Shuts the app down cleanly (orchestrator included) right before the install swaps the app in. */
  beforeInstall: () => Promise<void>;
}

function truncate(message: string, max: number): string {
  return message.length > max ? `${message.slice(0, max).trimEnd()}...` : message;
}

export class DesktopUpdater {
  #options: DesktopUpdaterOptions;
  #state: UpdaterState = { kind: "idle" };
  #started = false;
  #firstCheckTimer: ReturnType<typeof setTimeout> | null = null;
  #intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DesktopUpdaterOptions) {
    this.#options = options;
  }

  get state(): UpdaterState {
    return this.#state;
  }

  /**
   * Wires up autoUpdater and starts the check schedule. Safe to call once
   * only; a second call is a no-op rather than double-registering listeners
   * or stacking a second pair of timers.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    const support = updateSupport({
      platform: process.platform,
      packaged: app.isPackaged,
      appImage: Boolean(process.env.APPIMAGE),
    });
    if (!support.supported) {
      // Never touch autoUpdater on an unsupported install: in a dev build
      // there is no app-update.yml on disk, and every autoUpdater call
      // (checkForUpdates included) rejects against a config file that isn't
      // there.
      this.#setState({ kind: "unsupported", reason: support.reason });
      return;
    }

    const { state: reconciled, failed } = reconcile(readUpdateState(), this.#options.currentVersion);
    writeUpdateState(reconciled);
    if (failed) this.#options.onRollback?.(failed);

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    this.#registerListeners();

    this.#firstCheckTimer = setTimeout(() => this.checkNow(), FIRST_CHECK_DELAY_MS);
    this.#intervalTimer = setInterval(() => this.checkNow(), CHECK_INTERVAL_MS);
  }

  /** Clears both timers. Never throws: called from quit teardown, where nothing should be able to block shutdown. */
  stop(): void {
    if (this.#firstCheckTimer) clearTimeout(this.#firstCheckTimer);
    if (this.#intervalTimer) clearInterval(this.#intervalTimer);
    this.#firstCheckTimer = null;
    this.#intervalTimer = null;
  }

  /** Ask the feed for updates now. A no-op when unsupported or an install is already in flight. */
  checkNow(): void {
    if (this.#state.kind === "unsupported") return;
    if (this.#state.kind === "downloading" || this.#state.kind === "ready" || this.#state.kind === "installing") {
      return;
    }
    this.#setState({ kind: "checking" });
    // checkForUpdates() rejects on a network failure (there's no other catch
    // for that promise), so map the rejection onto the error state instead of
    // letting it become an unhandled rejection.
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      this.#setState({ kind: "error", message: truncate(errorMessage(error), MAX_ERROR_MESSAGE_LENGTH) });
    });
  }

  /** Installs a downloaded update now. Resolves false when nothing is ready to install. */
  async install(): Promise<boolean> {
    if (this.#state.kind !== "ready") return false;
    const version = this.#state.version;

    this.#setState({ kind: "installing", version });
    // Persist BEFORE anything irreversible: if the process dies partway
    // through the install, a launch back on the old version needs this on
    // disk already to know the install did not take (see reconcile).
    writeUpdateState(markInstallStarted(readUpdateState(), this.#options.currentVersion, version));

    // The app is about to be replaced and relaunched. The orchestrator child
    // this process spawned has to be stopped before the new version starts
    // its own, or the two fight over ~/.brevi/server.pid and the port. Never
    // let a teardown failure stop the install: an orchestrator that won't
    // shut down cleanly shouldn't trap the app on the old version forever.
    await this.#options.beforeInstall().catch((error: unknown) => {
      console.error("brevi: teardown before update install failed", error);
    });

    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  /** Called whenever the fleet changes: applies a ready update as soon as nothing is running or queued. */
  runsChanged(): void {
    if (this.#state.kind !== "ready") return;
    // Refresh the busy count shown in the tray line even before it's safe to install.
    this.#setState({ kind: "ready", version: this.#state.version, busyRuns: this.#options.busyRuns() });
    this.#maybeInstall();
  }

  #registerListeners(): void {
    autoUpdater.on("checking-for-update", () => {
      this.#setState({ kind: "checking" });
    });

    autoUpdater.on("update-available", (info) => {
      // A release that already failed to install twice is never retried.
      if (isQuarantined(readUpdateState(), info.version)) {
        this.#setState({ kind: "idle" });
        return;
      }
      this.#setState({ kind: "downloading", version: info.version, percent: 0 });
      void autoUpdater.downloadUpdate();
    });

    autoUpdater.on("update-not-available", () => {
      this.#setState({ kind: "idle", lastCheckedAt: Date.now() });
    });

    autoUpdater.on("download-progress", (progress) => {
      if (this.#state.kind !== "downloading") return;
      this.#setState({ kind: "downloading", version: this.#state.version, percent: progress.percent });
    });

    autoUpdater.on("update-downloaded", (event) => {
      const version = event.version;
      this.#setState({ kind: "ready", version, busyRuns: this.#options.busyRuns() });
      this.#options.onUpdateReady?.(version);
      this.#maybeInstall();
    });

    autoUpdater.on("error", (error) => {
      this.#setState({ kind: "error", message: truncate(errorMessage(error), MAX_ERROR_MESSAGE_LENGTH) });
    });
  }

  /**
   * The whole "no user action" path: whenever the state is ready and there
   * is neither a running nor a queued run, install right away instead of
   * waiting for a menu click. A user can still install early from the tray
   * while runs are in flight (updateAction only offers that when the state
   * is ready), but the common case is the update just applies itself the
   * moment the machine goes idle.
   */
  #maybeInstall(): void {
    if (shouldInstallNow(this.#state, this.#options.busyRuns())) {
      void this.install();
    }
  }

  #setState(state: UpdaterState): void {
    this.#state = state;
    this.#options.onState(state);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

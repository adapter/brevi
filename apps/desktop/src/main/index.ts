import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { app, dialog, nativeImage, shell } from "electron";
import type { HealthResponse } from "@brevi/shared";
import { startOrchestrator } from "@brevi/orchestrator";
import { loadConfig } from "@brevi/shared";
import { ensureConfig } from "./config.js";
import { FleetMonitor } from "./fleet.js";
import { orchestratorUrl, probeHealth } from "./health.js";
import { notifyRunFinished, notifyUpdateFailed, notifyUpdateReady } from "./notifications.js";
import { ORCHESTRATOR_LOG_PATH } from "./paths.js";
import { countRuns, menuRuns, updateBlockingRuns } from "./summary.js";
import { launchAtLoginEnabled, openedAtLogin, setLaunchAtLogin } from "./autostart.js";
import { OrchestratorSupervisor, type SupervisorState } from "./supervisor.js";
import { FleetTray, type TrayView } from "./tray.js";
import { updateAction } from "./update-policy.js";
import { DesktopUpdater } from "./updater.js";
import { MissionControl } from "./window.js";
import { registerDashboardProtocol, registerDashboardScheme } from "./protocol.js";
import { provisionWorkerOverSsh } from "./ssh.js";
import { resolveHostExecution, startLocalWorker } from "./local-worker.js";

/** How many recent runs the tray menu lists (see summary.ts's menuRuns). */
const MENU_RUN_LIMIT = 6;

/** Product name shown in the macOS app menu, dock, About panel, and dialogs. */
const APP_NAME = "brevi";

const here = dirname(fileURLToPath(import.meta.url));

let missionControl: MissionControl | undefined;
let tray: FleetTray | undefined;
let supervisor: OrchestratorSupervisor | undefined;
let fleet: FleetMonitor | undefined;
let updater: DesktopUpdater | undefined;
let quitting = false;
const managementToken = randomBytes(32).toString("base64url");

registerDashboardScheme();

// Must run before ready. Sets About/Quit labels and the Linux WM name.
// The macOS menu bar and dock read the .app bundle instead; source
// launches go through scripts/start.ts so that bundle is named brevi.
app.setName(APP_NAME);

// The default application menu already wires Cmd+Q to quit and gives every
// BrowserWindow the standard Edit menu (copy/paste, etc.), so there's
// nothing to hand-roll here; not calling Menu.setApplicationMenu keeps it.

// The single-instance lock is what makes launching brevi twice a no-op
// instead of a second orchestrator: the losing process quits immediately,
// and the winner focuses its existing window when Electron tells it about
// the second launch attempt.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => missionControl?.show());
  app.on("activate", () => missionControl?.show());
  // Closing the window leaves brevi running in the tray, still scheduling.
  app.on("window-all-closed", () => {});

  void app.whenReady().then(main);
}

/**
 * Shared teardown for both a normal quit and an update install: stop taking
 * new work, stop the updater's own timers, hand the window and fleet watcher
 * a chance to clean up, then stop the orchestrator (swallowing errors, since
 * a stuck child must not block either path) and destroy the tray icon.
 * Guarded by `quitting` so it only ever runs once, whichever path reaches it
 * first; an update install calls this itself before `quitAndInstall`, and
 * that same teardown must not run again when the resulting quit fires
 * `before-quit`.
 */
async function teardownForQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  updater?.stop();
  missionControl?.prepareForQuit();
  fleet?.stop();
  await (supervisor?.stop() ?? Promise.resolve()).catch(() => {
    // A stuck orchestrator process shouldn't trap the app open.
  });
  tray?.destroy();
}

async function main(): Promise<void> {
  registerDashboardProtocol(join(here, "app"));
  const iconPath = join(here, "..", "assets", "icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin" && !icon.isEmpty()) {
    app.dock?.setIcon(icon);
  }

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    iconPath,
  });

  const result = await ensureConfig().catch((err: unknown) => {
    dialog.showErrorBox(APP_NAME, err instanceof Error ? err.message : String(err));
    app.quit();
    return null;
  });
  if (!result) return;
  const { config, firstLaunch } = result;

  // The management listener is always loopback-only. Its port remains
  // configurable and is picked up on restart.
  let baseUrl = orchestratorUrl({ host: "127.0.0.1", port: config.server.port });
  const statusPage = join(here, "status.html");

  // A login launch belongs in the menu bar. The window is still created and
  // pointed at the status page so a later tray click reveals a ready one,
  // it just never puts itself on screen.
  const hiddenLaunch = openedAtLogin();
  missionControl = new MissionControl({
    baseUrl,
    apiToken: managementToken,
    statusPage,
    startHidden: hiddenLaunch,
  });
  missionControl.showStatus("loading");
  if (!hiddenLaunch) missionControl.show();

  let launchAtLogin = launchAtLoginEnabled();
  let health: HealthResponse | null = null;
  // Only load the dashboard the first time the orchestrator comes up after a
  // launch (or after a failure); once it's loaded, the dashboard's own
  // websocket reconnect logic rides out a supervisor restart on its own.
  let dashboardLoaded = false;

  tray = new FleetTray({
    onOpen: (path) => openWindow(path),
    onRestartOrchestrator: () => void restartOrchestrator(),
    onToggleLaunchAtLogin: (enabled) => {
      setLaunchAtLogin(enabled);
      launchAtLogin = enabled;
      refreshTray();
    },
    onOpenLogs: () => void shell.openPath(ORCHESTRATOR_LOG_PATH),
    onUpdate: () => handleUpdateAction(),
    onQuit: () => app.quit(),
  });

  supervisor = new OrchestratorSupervisor({
    startOrchestrator: async () => {
      // Probed at every (re)start rather than once: installing bubblewrap or
      // fixing a Seatbelt problem then restarting the orchestrator is enough
      // to turn local execution on.
      const config = await loadConfig();
      const hostExecution = await resolveHostExecution(config.agent.command);
      const handle = await startOrchestrator({
        config,
        managementToken,
        provisionWorker: provisionWorkerOverSsh,
        hostExecution,
      });
      const localWorker =
        hostExecution.kind === "local-worker" ? startLocalWorker(handle) : null;
      return {
        ...handle,
        async stop() {
          // The worker drains first so its final run reports still reach the
          // orchestrator it is about to lose.
          await localWorker?.stop();
          await handle.stop();
        },
      };
    },
    onState: (state) => handleSupervisorState(state),
  });

  fleet = new FleetMonitor({
    url: baseUrl,
    token: managementToken,
    onChange: () => {
      refreshTray();
      updater?.runsChanged();
    },
    onRunFinished: (run) => notifyRunFinished(run, (path) => openWindow(path)),
  });

  // The orchestrator is bundled into Mission Control, so a desktop update is
  // also a host-runtime update.
  updater = new DesktopUpdater({
    currentVersion: app.getVersion(),
    busyRuns: () => updateBlockingRuns(countRuns(fleet?.state.runs ?? [])),
    onState: () => refreshTray(),
    onUpdateReady: (version) => notifyUpdateReady(version, () => openWindow()),
    onRollback: (version) => notifyUpdateFailed(version),
    beforeInstall: () => teardownForQuit(),
  });

  /**
   * Restart the in-process orchestrator and pick up an edited server port.
   */
  async function restartOrchestrator(): Promise<void> {
    const current = await loadConfig().catch(() => null);
    const nextUrl = current
      ? orchestratorUrl({ host: "127.0.0.1", port: current.server.port })
      : baseUrl;
    if (nextUrl !== baseUrl) {
      baseUrl = nextUrl;
      fleet?.setUrl(baseUrl);
      missionControl?.setBaseUrl(baseUrl);
      // The window is pointed at the old address; put it back on the status
      // page so the reload lands on the new one once the orchestrator answers.
      dashboardLoaded = false;
      missionControl?.showStatus("loading");
    }
    await supervisor?.restart();
  }

  /**
   * Tray and notification clicks. Before the orchestrator answers, the window
   * is on the status page: showing it without a path avoids navigating to a
   * URL nothing is listening on yet.
   */
  function openWindow(path?: string): void {
    missionControl?.show(dashboardLoaded ? path : undefined);
  }

  /** Tray's update menu item click: what it does depends entirely on the updater's current state. */
  function handleUpdateAction(): void {
    if (!updater) return;
    const action = updateAction(updater.state);
    if (action === "install") void updater.install();
    else if (action === "check") updater.checkNow();
  }

  function handleSupervisorState(state: SupervisorState): void {
    if (state.kind === "running") {
      if (!dashboardLoaded) {
        dashboardLoaded = true;
        // Only a genuinely first launch (no config file yet) lands on the
        // setup route; every later launch, including a restart after a
        // crash, goes straight to the dashboard.
        missionControl?.loadDashboard(firstLaunch ? "/setup" : undefined);
      }
      void probeHealth(baseUrl).then((result) => {
        health = result;
        refreshTray();
      });
    } else if (state.kind === "failed") {
      dashboardLoaded = false;
      health = null;
      missionControl?.showStatus("error", state.reason);
    }
    refreshTray();
  }

  function refreshTray(): void {
    if (!tray || !fleet || !supervisor) return;
    const view: TrayView = {
      counts: countRuns(fleet.state.runs),
      runs: menuRuns(fleet.state.runs, MENU_RUN_LIMIT),
      supervisor: supervisor.state,
      health,
      connected: fleet.state.connected,
      launchAtLogin,
      url: baseUrl,
      update: updater?.state ?? { kind: "idle" },
      appVersion: app.getVersion(),
    };
    tray.update(view);
  }

  // Registered before the orchestrator is started, so quitting mid-startup
  // still shuts down whatever the supervisor has already spawned. A stuck
  // orchestrator must not trap the app open, so the actual teardown always
  // runs to completion (see teardownForQuit) before the app is allowed to quit.
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void teardownForQuit().finally(() => app.quit());
  });

  refreshTray();
  fleet.start();
  await supervisor.start();
  // Update checks deliberately begin only once the orchestrator is up, so
  // they never compete with it for startup time.
  updater.start();
}

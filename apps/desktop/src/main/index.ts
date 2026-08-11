import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, dialog, shell } from "electron";
import type { HealthResponse } from "@brevi/shared";
import { loadConfig } from "@brevi/orchestrator/config";
import { ensureConfig } from "./config.js";
import { FleetMonitor } from "./fleet.js";
import { orchestratorUrl, probeHealth } from "./health.js";
import { notifyRunFinished } from "./notifications.js";
import { ORCHESTRATOR_LOG_PATH, resolveCliEntry } from "./paths.js";
import { countRuns, menuRuns } from "./summary.js";
import { launchAtLoginEnabled, openedAtLogin, setLaunchAtLogin } from "./autostart.js";
import { OrchestratorSupervisor, type SupervisorState } from "./supervisor.js";
import { FleetTray, type TrayView } from "./tray.js";
import { MissionControl } from "./window.js";

/** How many recent runs the tray menu lists (see summary.ts's menuRuns). */
const MENU_RUN_LIMIT = 6;

const here = dirname(fileURLToPath(import.meta.url));

let missionControl: MissionControl | undefined;
let tray: FleetTray | undefined;
let supervisor: OrchestratorSupervisor | undefined;
let fleet: FleetMonitor | undefined;
let quitting = false;

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

async function main(): Promise<void> {
  const result = await ensureConfig().catch((err: unknown) => {
    dialog.showErrorBox("brevi", err instanceof Error ? err.message : String(err));
    app.quit();
    return null;
  });
  if (!result) return;
  const { config, firstLaunch } = result;

  // Mutable: server.host and server.port are editable from the dashboard and
  // apply on restart, so every component holding an address has to be moved
  // with them (see restartOrchestrator).
  let baseUrl = orchestratorUrl(config.server);
  const statusPage = join(here, "status.html");

  // A login launch belongs in the menu bar. The window is still created and
  // pointed at the status page so a later tray click reveals a ready one,
  // it just never puts itself on screen.
  const hiddenLaunch = openedAtLogin();
  missionControl = new MissionControl({ baseUrl, statusPage, startHidden: hiddenLaunch });
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
    onOpenExternal: () => void shell.openExternal(baseUrl),
    onRestartOrchestrator: () => void restartOrchestrator(),
    onToggleLaunchAtLogin: (enabled) => {
      setLaunchAtLogin(enabled);
      launchAtLogin = enabled;
      refreshTray();
    },
    onOpenLogs: () => void shell.openPath(ORCHESTRATOR_LOG_PATH),
    onQuit: () => app.quit(),
  });

  supervisor = new OrchestratorSupervisor({
    cliEntry: resolveCliEntry({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, here }),
    runtime: process.execPath,
    url: baseUrl,
    onState: (state) => handleSupervisorState(state),
  });

  fleet = new FleetMonitor({
    url: baseUrl,
    onChange: () => refreshTray(),
    onRunFinished: (run) => notifyRunFinished(run, (path) => openWindow(path)),
  });

  /**
   * Restart the orchestrator, picking up an edited server.host/server.port on
   * the way. The child re-reads the config when it boots, so a supervisor
   * still probing the old address would health-check a socket nothing is
   * bound to and kill the healthy child as unhealthy, over and over. Re-read
   * the config here and move every component holding an address before the
   * restart, not after.
   */
  async function restartOrchestrator(): Promise<void> {
    const current = await loadConfig().catch(() => null);
    const nextUrl = current ? orchestratorUrl(current.server) : baseUrl;
    if (nextUrl !== baseUrl) {
      baseUrl = nextUrl;
      supervisor?.setUrl(baseUrl);
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

  function handleSupervisorState(state: SupervisorState): void {
    if (state.kind === "running" || state.kind === "attached") {
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
    } else if (state.kind === "idle") {
      dashboardLoaded = false;
      health = null;
      missionControl?.showStatus(
        "error",
        "The orchestrator was stopped from outside the app. Start it again from the menu bar.",
      );
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
    };
    tray.update(view);
  }

  // Registered before the orchestrator is started, so quitting mid-startup
  // still shuts down whatever the supervisor has already spawned.
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    missionControl?.prepareForQuit();
    fleet?.stop();
    (supervisor?.stop() ?? Promise.resolve())
      .catch(() => {
        // Quit either way; a stuck orchestrator process shouldn't trap the app open.
      })
      .finally(() => {
        tray?.destroy();
        app.quit();
      });
  });

  refreshTray();
  fleet.start();
  await supervisor.start();
}

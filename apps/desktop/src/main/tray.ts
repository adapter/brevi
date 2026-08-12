import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { HealthResponse, Run } from "@brevi/shared";
import { fleetLine, orchestratorVersionLine, runLabel, trayTitle, workerLine, type FleetCounts } from "./summary.js";
import type { SupervisorState } from "./supervisor.js";
import { updateLine, updateMenuItem, type UpdaterState } from "./update-policy.js";

// The main bundle is dist/main.js; assets ship as siblings of dist (see
// apps/desktop/package.json's build script and electron-builder.yml).
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

/** Electron treats the "Template" suffix as a menu-bar template image and adapts it to light/dark menu bars automatically. */
function iconPath(): string {
  return process.platform === "darwin" ? join(ASSETS_DIR, "trayTemplate.png") : join(ASSETS_DIR, "tray-light.png");
}

export interface TrayView {
  counts: FleetCounts;
  /** Already trimmed by menuRuns. */
  runs: readonly Run[];
  supervisor: SupervisorState;
  health: HealthResponse | null;
  /** Fleet websocket state. */
  connected: boolean;
  launchAtLogin: boolean;
  url: string;
  update: UpdaterState;
  appVersion: string;
}

export interface FleetTrayOptions {
  onOpen: (path?: string) => void;
  /** Open the dashboard in the system browser. */
  onOpenExternal: () => void;
  onRestartOrchestrator: () => void;
  onToggleLaunchAtLogin: (enabled: boolean) => void;
  onOpenLogs: () => void;
  onUpdate: () => void;
  onQuit: () => void;
}

const MAX_RUN_ITEMS = 6;

export class FleetTray {
  #options: FleetTrayOptions;
  #tray: Tray;

  constructor(options: FleetTrayOptions) {
    this.#options = options;
    this.#tray = new Tray(nativeImage.createFromPath(iconPath()));
    // On macOS, setting a context menu makes it appear on any click, so this
    // handler mostly matters on Windows/Linux, where left-click is distinct
    // from the right-click that opens the context menu.
    this.#tray.on("click", () => this.#options.onOpen());
  }

  update(view: TrayView): void {
    const menu = Menu.buildFromTemplate(this.#buildTemplate(view));
    this.#tray.setContextMenu(menu);
    const tooltipLines = [fleetLine(view.counts), workerLine(view.supervisor)];
    const update = updateLine(view.update);
    if (update) tooltipLines.push(update);
    this.#tray.setToolTip(tooltipLines.join("\n"));
    if (process.platform === "darwin") this.#tray.setTitle(trayTitle(view.counts));
  }

  destroy(): void {
    this.#tray.destroy();
  }

  #buildTemplate(view: TrayView): MenuItemConstructorOptions[] {
    const header: MenuItemConstructorOptions[] = [
      { label: fleetLine(view.counts), enabled: false },
      { label: workerLine(view.supervisor), enabled: false },
    ];
    if (view.health) header.push({ label: `Sandbox: ${view.health.sandboxProvider}`, enabled: false });
    if (!view.connected) header.push({ label: "Dashboard: offline", enabled: false });
    const update = updateLine(view.update);
    if (update) header.push({ label: update, enabled: false });
    const versionLine = orchestratorVersionLine(
      view.appVersion,
      view.supervisor.kind === "attached",
      view.health?.version,
    );
    if (versionLine) header.push({ label: versionLine, enabled: false });

    // "Restart" implies something is already running; when it isn't (stopped
    // from outside the app, or never came up), the same click handler should
    // read as starting it instead.
    const orchestratorStopped =
      view.supervisor.kind === "idle" || view.supervisor.kind === "stopped" || view.supervisor.kind === "failed";

    const runItems: MenuItemConstructorOptions[] =
      view.runs.length > 0
        ? view.runs
            .slice(0, MAX_RUN_ITEMS)
            .map((run) => ({
              label: runLabel(run),
              click: () => this.#options.onOpen(`/runs/${encodeURIComponent(run.id)}`),
            }))
        : [{ label: "No runs yet", enabled: false }];

    return [
      ...header,
      { type: "separator" },
      ...runItems,
      { type: "separator" },
      { label: "Open Mission Control", click: () => this.#options.onOpen() },
      { label: "Open in Browser", click: () => this.#options.onOpenExternal() },
      {
        label: orchestratorStopped ? "Start Orchestrator" : "Restart Orchestrator",
        click: () => this.#options.onRestartOrchestrator(),
      },
      { label: "Open Logs", click: () => this.#options.onOpenLogs() },
      { ...updateMenuItem(view.update), click: () => this.#options.onUpdate() },
      { type: "separator" },
      {
        label: "Start at Login",
        type: "checkbox",
        checked: view.launchAtLogin,
        click: (item) => this.#options.onToggleLaunchAtLogin(item.checked),
      },
      { type: "separator" },
      { label: "Quit brevi", accelerator: "CommandOrControl+Q", click: () => this.#options.onQuit() },
    ];
  }
}

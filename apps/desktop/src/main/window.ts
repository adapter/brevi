import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, dialog, shell } from "electron";

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

export interface MissionControlOptions {
  /** Private orchestrator base URL used by the local renderer. */
  baseUrl: string;
  apiToken: string;
  /** Absolute path of the local status page (src/renderer/status.html, resolved by the caller). */
  statusPage: string;
  /** True for a launch the login item started, which belongs in the menu bar rather than on screen. */
  startHidden?: boolean;
}

/**
 * The single dashboard window. Closing it just hides it (brevi keeps
 * scheduling from the tray); only prepareForQuit() before app quit allows
 * the close to go through for real.
 */
export class MissionControl {
  #options: MissionControlOptions;
  #window: BrowserWindow | null = null;
  #quitting = false;
  // A packaging regression (the status page not shipped, a bad statusPage
  // path) would otherwise fail on every showStatus() call; report it once so
  // it's a visible diagnostic instead of a silent loop of blank windows.
  #reportedLoadFailure = false;
  /**
   * Whether a freshly created window reveals itself once it can paint. False
   * for a launch the login item started: that launch is meant to land in the
   * menu bar, but the window is still created and loaded in the background so
   * a later tray click reveals a ready one. An explicit show() sets it, so
   * the user asking for the window always wins.
   */
  #autoShow: boolean;

  constructor(options: MissionControlOptions) {
    this.#options = options;
    this.#autoShow = !options.startHidden;
  }

  /** Repoint at a different orchestrator address; the next load uses it. */
  setBaseUrl(baseUrl: string): void {
    this.#options = { ...this.#options, baseUrl };
  }

  get isVisible(): boolean {
    return this.#window !== null && !this.#window.isDestroyed() && this.#window.isVisible();
  }

  /** Create or focus the window, navigating to `path` under the orchestrator when given. */
  show(path?: string): void {
    this.#autoShow = true;
    const window = this.#ensureWindow();
    if (path) this.loadDashboard(path);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /** Point the window at the local status page while the orchestrator comes up or after it fails. */
  showStatus(state: "loading" | "error", detail?: string): void {
    const window = this.#ensureWindow();
    window
      .loadFile(this.#options.statusPage, { query: { state, detail: detail ?? "" } })
      .catch((err: unknown) =>
        this.#reportLoadFailure(`the local status page (${state}) at ${this.#options.statusPage}`, err),
      );
  }

  /**
   * Load the dashboard itself; called once the orchestrator answers a health
   * probe, so by this point loadURL failing is not the normal
   * still-starting-up race (that's ridden out before this is ever called)
   * but a genuine problem worth surfacing, e.g. a malformed baseUrl.
   */
  loadDashboard(path?: string): void {
    const window = this.#ensureWindow();
    const query = new URLSearchParams({
      apiBase: this.#options.baseUrl,
      token: this.#options.apiToken,
    });
    const url = `brevi://app${path ?? "/"}?${query}`;
    window.loadURL(url).catch((err: unknown) => this.#reportLoadFailure(`the dashboard at ${url}`, err));
  }

  /** Allow the window to be destroyed on quit instead of hidden. */
  prepareForQuit(): void {
    this.#quitting = true;
  }

  destroy(): void {
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  #reportLoadFailure(what: string, err: unknown): void {
    if (this.#reportedLoadFailure) return;
    this.#reportedLoadFailure = true;
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox("brevi", `Failed to load ${what}: ${message}`);
  }

  #ensureWindow(): BrowserWindow {
    const existing = this.#window;
    if (existing && !existing.isDestroyed()) return existing;

    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: "#0d0d0d",
      show: false, // shown on 'ready-to-show' to avoid a white flash
      title: "brevi",
      // No title bar: on macOS the traffic lights float over the sidebar
      // header (the renderer pads and drags that strip); elsewhere the
      // option is ignored and the native frame stays.
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 16 },
      // macOS reads the .app icon for the dock; this is what Linux uses
      // for the taskbar / window list.
      icon: join(ASSETS_DIR, "icon.png"),
      webPreferences: {
        // SSH credentials and provisioning stay in the main process. The
        // renderer receives only a random per-launch API token.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.once("ready-to-show", () => {
      if (this.#autoShow) window.show();
    });

    window.on("close", (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      window.hide();
    });

    // Links to GitHub, Linear, OAuth pages, etc. never open inside the app
    // window; they go to the system browser, and only when they're http(s).
    window.webContents.setWindowOpenHandler((details) => {
      this.#openExternal(details.url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (details) => {
      if (this.#isOwnOrigin(details.url)) return;
      details.preventDefault();
      this.#openExternal(details.url);
    });

    this.#window = window;
    return window;
  }

  #isOwnOrigin(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "brevi:" && parsed.host === "app";
    } catch {
      return false;
    }
  }

  #openExternal(url: string): void {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
    } catch {
      // Not a parseable URL; nothing to open.
    }
  }
}

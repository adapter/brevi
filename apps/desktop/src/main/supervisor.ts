import type { OrchestratorHandle } from "@brevi/orchestrator";

export type SupervisorState =
  | { kind: "starting" }
  | { kind: "running"; pid: number }
  | { kind: "failed"; reason: string }
  | { kind: "stopped" };

export interface SupervisorOptions {
  startOrchestrator: () => Promise<OrchestratorHandle>;
  onState?: (state: SupervisorState) => void;
}

/**
 * Owns the orchestrator inside Electron's main process. There is deliberately
 * no adoption or child-process mode: Mission Control is now the sole host
 * runtime, so app shutdown and orchestrator shutdown have one lifecycle.
 */
export class OrchestratorSupervisor {
  #options: SupervisorOptions;
  #state: SupervisorState = { kind: "stopped" };
  #handle: OrchestratorHandle | null = null;
  #operation: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.#options = options;
  }

  get state(): SupervisorState {
    return this.#state;
  }

  get ownsProcess(): boolean {
    return this.#handle !== null;
  }

  get pid(): number | null {
    return this.#handle ? process.pid : null;
  }

  start(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#handle) return;
      this.#setState({ kind: "starting" });
      try {
        this.#handle = await this.#options.startOrchestrator();
        this.#setState({ kind: "running", pid: process.pid });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#setState({ kind: "failed", reason });
      }
    });
  }

  restart(): Promise<void> {
    return this.#serialize(async () => {
      await this.#stopHandle();
      this.#setState({ kind: "starting" });
      try {
        this.#handle = await this.#options.startOrchestrator();
        this.#setState({ kind: "running", pid: process.pid });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#setState({ kind: "failed", reason });
      }
    });
  }

  stop(): Promise<void> {
    return this.#serialize(async () => {
      await this.#stopHandle();
      this.#setState({ kind: "stopped" });
    });
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    this.#operation = this.#operation.then(operation, operation);
    return this.#operation;
  }

  async #stopHandle(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    if (handle) await handle.stop();
  }

  #setState(state: SupervisorState): void {
    this.#state = state;
    this.#options.onState?.(state);
  }
}

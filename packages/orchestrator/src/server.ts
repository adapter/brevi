import type { BreviConfig } from "@brevi/shared";

export interface StartOptions {
  /** Pre-loaded config; when omitted, loaded from configPath. */
  config?: BreviConfig;
  configPath?: string;
}

export interface OrchestratorHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export async function startOrchestrator(_options: StartOptions = {}): Promise<OrchestratorHandle> {
  throw new Error("orchestrator server not implemented yet");
}

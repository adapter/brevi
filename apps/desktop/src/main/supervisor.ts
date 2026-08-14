import { spawn, type ChildProcess } from "node:child_process";
import { readServerRecord } from "@brevi/orchestrator/pid";
import { HEALTHY_UPTIME_MS, MAX_RESTART_ATTEMPTS, restartDelay } from "./backoff.js";
import { probeHealth, waitForHealth } from "./health.js";

const START_TIMEOUT_MS = 60_000;
const ATTACHED_POLL_INTERVAL_MS = 5_000;
// Above the local worker's 35s drain window inside `brevi start`'s own
// shutdown, so a busy worker's final frames land before SIGKILL.
const STOP_GRACEFUL_TIMEOUT_MS = 45_000;
const LOG_BUFFER_LINES = 200;
/** How long to wait, while starting, for a server another process is already bringing up to become healthy. */
const ADOPT_TIMEOUT_MS = 30_000;
const ADOPT_POLL_INTERVAL_MS = 500;

export type SupervisorState =
  | { kind: "starting" }
  | { kind: "running"; pid: number }
  /** An orchestrator started elsewhere (the CLI) is already up; the app uses it instead of starting a second one. */
  | { kind: "attached"; pid: number | null }
  | { kind: "restarting"; attempt: number; delayMs: number; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "stopped" }
  /** No orchestrator; stopped deliberately from outside (a human, or `brevi stop`), so we watch instead of respawning. */
  | { kind: "idle"; reason: string };

export interface SupervisorOptions {
  cliEntry: string;
  /** Executable that runs the CLI: Electron's own binary, with ELECTRON_RUN_AS_NODE=1. */
  runtime: string;
  url: string;
  onState?: (state: SupervisorState) => void;
  onLog?: (line: string) => void;
}

/** Human-readable reason for an unexpected child exit, used as restart/failure context. */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `terminated by signal ${signal}`;
  if (code !== null) return `exited with code ${code}`;
  return "exited unexpectedly";
}

export class OrchestratorSupervisor {
  private options: SupervisorOptions;
  private _state: SupervisorState = { kind: "stopped" };

  private child: ChildProcess | null = null;
  private owns = false;
  private attachedPid: number | null = null;

  private readonly logs: string[] = [];
  private stdoutRemainder = "";
  private stderrRemainder = "";

  /** Consecutive crash count since the last healthy run; drives restartDelay and the failure cutoff. */
  private restartAttempt = 0;
  /** True while stop() is tearing things down, so the child's own exit isn't mistaken for a crash. */
  private stopping = false;
  /**
   * Children we killed ourselves because they never became healthy inside
   * START_TIMEOUT_MS. That kill arrives at the exit handler as a SIGTERM
   * exit, same shape as a deliberate outside stop; this set is what tells
   * the two apart so a startup timeout still counts as a crash.
   */
  private readonly killedUnhealthy = new WeakSet<ChildProcess>();

  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private attachPollTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  get state(): SupervisorState {
    return this._state;
  }

  /** True when this app spawned the orchestrator, so quitting must stop it. */
  get ownsProcess(): boolean {
    return this.owns;
  }

  /** Pid of the orchestrator: our child, or the pid file's when attached. */
  get pid(): number | null {
    return this.owns ? (this.child?.pid ?? null) : this.attachedPid;
  }

  /** Recent orchestrator output, newest last, for the log view. */
  recentLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Repoint at a different orchestrator address. `server.port`/`server.host`
   * are editable from the dashboard and take effect when the orchestrator
   * restarts, so the address this supervisor probes has to move with them:
   * left on the old one it would health-check a socket nothing is bound to,
   * kill the perfectly healthy child as unhealthy, and do it again.
   */
  setUrl(url: string): void {
    this.options = { ...this.options, url };
  }

  async start(): Promise<void> {
    this.stopping = false;

    const health = await probeHealth(this.options.url);
    if (health) {
      this.attach(readServerRecord()?.pid ?? null);
      return;
    }

    // Someone else may be starting a server right now (another terminal's
    // `brevi start`, racing us on launch). Give it a chance to come up
    // instead of piling a second instance on top of it.
    if (await this.tryAdopt()) return;

    this.restartAttempt = 0;
    await this.spawnOwn();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.restartAttempt = 0;
    await this.start();
  }

  /**
   * Cancels every timer, and when we own the process sends SIGTERM (the
   * CLI's SIGTERM handler shuts the orchestrator down cleanly), waits up to
   * STOP_GRACEFUL_TIMEOUT_MS, then SIGKILL. When attached it only cancels
   * timers and leaves the other instance running.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearAttachPoll();
    this.clearIdlePoll();
    this.clearRestartTimer();
    this.clearHealthyTimer();

    const child = this.child;
    if (this.owns && child) {
      await this.terminate(child);
    }

    this.child = null;
    this.owns = false;
    this.attachedPid = null;
    this.setState({ kind: "stopped" });
    this.stopping = false;
  }

  // -- adopting a server another process is bringing up ------------------

  /**
   * Polls health while a live pid file names another process bringing up a
   * server, up to ADOPT_TIMEOUT_MS. Attaches and returns true once it
   * answers; returns false (to fall through to spawning our own) once that
   * pid is gone or the window elapses.
   */
  private async tryAdopt(): Promise<boolean> {
    const deadline = Date.now() + ADOPT_TIMEOUT_MS;
    for (;;) {
      const record = readServerRecord();
      if (!record) return false;

      const health = await probeHealth(this.options.url);
      if (health) {
        this.attach(record.pid);
        return true;
      }

      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, ADOPT_POLL_INTERVAL_MS));
    }
  }

  // -- attach mode -----------------------------------------------------

  /** Adopt an orchestrator we didn't start: another instance already up, or one that just became healthy. */
  private attach(pid: number | null): void {
    this.clearAttachPoll();
    this.clearIdlePoll();
    this.owns = false;
    this.attachedPid = pid;
    this.restartAttempt = 0;
    this.setState({ kind: "attached", pid });
    this.scheduleAttachPoll();
  }

  private scheduleAttachPoll(): void {
    let consecutiveFailures = 0;
    const poll = async (): Promise<void> => {
      if (this.stopping || this.owns) return;

      const health = await probeHealth(this.options.url);
      if (health) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        // Two consecutive failed probes mean the attached instance is gone;
        // take over instead of waiting on it forever.
        if (consecutiveFailures >= 2) {
          this.restartAttempt = 0;
          await this.spawnOwn();
          return;
        }
      }

      if (this.stopping || this.owns) return;
      this.attachPollTimer = setTimeout(() => void poll(), ATTACHED_POLL_INTERVAL_MS);
    };
    this.attachPollTimer = setTimeout(() => void poll(), ATTACHED_POLL_INTERVAL_MS);
  }

  private clearAttachPoll(): void {
    if (this.attachPollTimer) clearTimeout(this.attachPollTimer);
    this.attachPollTimer = null;
  }

  // -- idle mode: stopped from outside, watching but not respawning ------

  private goIdle(reason: string): void {
    this.clearAttachPoll();
    this.owns = false;
    this.attachedPid = null;
    this.setState({ kind: "idle", reason });
    this.scheduleIdlePoll();
  }

  /** Watches for a server appearing again (e.g. `brevi update`'s restart) without ever spawning one itself. */
  private scheduleIdlePoll(): void {
    this.clearIdlePoll();
    const poll = async (): Promise<void> => {
      if (this.stopping || this.owns) return;

      const health = await probeHealth(this.options.url);
      if (health) {
        this.attach(readServerRecord()?.pid ?? null);
        return;
      }

      if (this.stopping || this.owns) return;
      this.idlePollTimer = setTimeout(() => void poll(), ATTACHED_POLL_INTERVAL_MS);
    };
    this.idlePollTimer = setTimeout(() => void poll(), ATTACHED_POLL_INTERVAL_MS);
  }

  private clearIdlePoll(): void {
    if (this.idlePollTimer) clearTimeout(this.idlePollTimer);
    this.idlePollTimer = null;
  }

  // -- owning and supervising a spawned process -------------------------

  private async spawnOwn(): Promise<void> {
    this.clearAttachPoll();
    this.clearIdlePoll();
    this.owns = true;
    this.attachedPid = null;
    this.setState({ kind: "starting" });

    const child = spawn(this.options.runtime, [this.options.cliEntry, "start"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BREVI_SUPERVISOR_PID: String(process.pid) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.attachOutput(child);

    // Registered once per child; classifies every exit that isn't a
    // superseded/deliberate stop() call (see handleExit).
    child.once("exit", (code, signal) => {
      void this.handleExit(child, code, signal);
    });

    // A child process with no error listener throws on a spawn failure (a
    // missing runtime, a bad entry path), which would take the whole app down
    // with it. Treat it as a failed attempt and let the backoff retry.
    child.once("error", (error) => {
      if (this.stopping || this.child !== child) return;
      this.child = null;
      this.clearHealthyTimer();
      this.pushLog(`could not start the orchestrator: ${error.message}`);
      this.scheduleRestart(error.message);
    });

    // A spawn failure leaves pid undefined; the error event above drives the
    // restart, so there's nothing to wait for here.
    if (child.pid === undefined) return;

    const health = await waitForHealth(this.options.url, START_TIMEOUT_MS);
    // Superseded while we were waiting: stopped, or the exit listener above
    // already handled a crash.
    if (this.child !== child) return;

    if (!health) {
      // Never became healthy within the window: counts as a failed attempt.
      // Killing it triggers the exit listener above; mark it first so that
      // SIGTERM exit is classified as a crash, not a deliberate stop.
      this.killedUnhealthy.add(child);
      await this.terminate(child);
      return;
    }

    this.setState({ kind: "running", pid: child.pid });
    this.clearHealthyTimer();
    this.healthyTimer = setTimeout(() => {
      if (this.child === child) this.restartAttempt = 0;
    }, HEALTHY_UPTIME_MS);
  }

  /**
   * Classifies a child exit in order: superseded/stopping is ignored; a now-
   * healthy server (ours lost the port race, or another instance finished
   * starting) is attached without spending a restart attempt; a deliberate
   * outside shutdown (exit 0, or SIGTERM that wasn't our own unhealthy-kill)
   * goes idle instead of restarting; anything else is a crash.
   */
  private async handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.stopping || this.child !== child) return;
    this.child = null;
    this.clearHealthyTimer();

    const killedUnhealthy = this.killedUnhealthy.has(child);
    this.killedUnhealthy.delete(child);

    const health = await probeHealth(this.options.url);
    // stop() or a fresh spawnOwn() may have run while that probe was in
    // flight; either way this exit is no longer ours to classify, and acting
    // on it would leave a poll timer behind a supervisor that's meant to be
    // torn down.
    if (this.stopping || !this.owns || this.child !== null) return;

    if (health) {
      this.attach(readServerRecord()?.pid ?? null);
      return;
    }

    const deliberateOutsideStop = !killedUnhealthy && (code === 0 || signal === "SIGTERM");
    if (deliberateOutsideStop) {
      this.goIdle(describeExit(code, signal));
      return;
    }

    this.scheduleRestart(describeExit(code, signal));
  }

  private scheduleRestart(reason: string): void {
    this.restartAttempt += 1;
    if (this.restartAttempt > MAX_RESTART_ATTEMPTS) {
      this.setState({ kind: "failed", reason });
      return;
    }

    const delayMs = restartDelay(this.restartAttempt);
    this.setState({ kind: "restarting", attempt: this.restartAttempt, delayMs, reason });
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnOwn();
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearHealthyTimer(): void {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = null;
  }

  // -- output capture ----------------------------------------------------

  private attachOutput(child: ChildProcess): void {
    this.stdoutRemainder = "";
    this.stderrRemainder = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stdoutRemainder = this.consumeLines(this.stdoutRemainder + chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrRemainder = this.consumeLines(this.stderrRemainder + chunk);
    });
  }

  /** Pushes every complete line in `buffer` to the log, returning the trailing partial line. */
  private consumeLines(buffer: string): string {
    const lines = buffer.split("\n");
    const remainder = lines.pop() ?? "";
    for (const line of lines) this.pushLog(line);
    return remainder;
  }

  private pushLog(line: string): void {
    this.logs.push(line);
    if (this.logs.length > LOG_BUFFER_LINES) this.logs.shift();
    this.options.onLog?.(line);
  }

  // -- process teardown ---------------------------------------------------

  /** SIGTERM, then SIGKILL after a grace period; resolves once the child is gone. */
  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = this.waitForExit(child);
    child.kill("SIGTERM");

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, STOP_GRACEFUL_TIMEOUT_MS);
    });
    await Promise.race([exited, grace]);
    clearTimeout(graceTimer);

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }

  private waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once("exit", () => resolve()));
  }

  // -- state -----------------------------------------------------------

  private setState(state: SupervisorState): void {
    this._state = state;
    this.options.onState?.(state);
  }
}

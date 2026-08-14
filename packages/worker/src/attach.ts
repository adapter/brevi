import { join } from "node:path";
import { spawn, type IPty } from "@lydell/node-pty";
import { WORKSPACES_DIR, type AttachOpenMessage, type Run, type WorkerMessage } from "@brevi/shared";
import type { Sandbox, SandboxProvider } from "@brevi/sandbox";
import { collectAgentEnv, playwrightBrowsersPath } from "./runner.js";
import { provisionCredentials } from "./provision.js";
import { buildResumeScript } from "./resume.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AttachSessionsDeps {
  provider: SandboxProvider;
  /**
   * The run's last known state, as remembered by daemon.ts since this
   * worker last started: attach only works for runs this process has
   * actually executed, since that is the only place `agentSessionId` (and
   * the retained-disk bookkeeping) comes from.
   */
  getRun: (runId: string) => Run | undefined;
  /** Sends a WorkerMessage (attach-data/attach-exit/attach-error) back to the host. */
  send: (message: WorkerMessage) => void;
}

export interface AttachSessions {
  open(message: AttachOpenMessage): Promise<void>;
  input(attachId: string, data: string): void;
  resize(attachId: string, cols: number, rows: number): void;
  close(attachId: string): void;
  /** Tear down every open session and release every retained sandbox's compute; called on shutdown. */
  closeAll(): void;
}

interface RetainedEntry {
  pending: Promise<Sandbox>;
  /** How many open sessions share this boot; compute is released once this drops to zero. */
  clients: number;
}

interface Session {
  runId: string;
  pty?: IPty;
  /** Guards releaseRun() against running twice for one session (an exited pty and an explicit close racing). */
  released: boolean;
}

/**
 * Worker-side interactive sessions: rehydrates a finished run's retained
 * sandbox, reprovisions credentials, and bridges its PTY to the host over
 * the wire protocol's attach-* messages. This is the same job the
 * orchestrator's old `resumeRun`/`releaseRun` (scheduler.ts) and
 * `handleAttachSocket` (terminal.ts) did together when the host ran
 * sandboxes itself; here the sandbox lives on this worker, so the PTY does
 * too, and only its bytes cross the wire.
 */
export function createAttachSessions(deps: AttachSessionsDeps): AttachSessions {
  const { provider, getRun, send } = deps;
  // Keyed by runId, not attachId: two attach sessions on the same run (a CLI
  // attach and a dashboard web terminal, say) share one rehydrated boot,
  // same as the orchestrator's old #attached map.
  const retained = new Map<string, RetainedEntry>();
  const sessions = new Map<string, Session>();

  async function bootOrShare(runId: string, env: Record<string, string>): Promise<Sandbox> {
    let entry = retained.get(runId);
    if (!entry) {
      const pending = provider.rehydrate({ id: runId, env });
      entry = { pending, clients: 0 };
      retained.set(runId, entry);
      // A failed boot must not poison later attempts to attach to this run.
      pending.catch(() => {
        if (retained.get(runId) === entry) retained.delete(runId);
      });
    }
    const sandbox = await entry.pending;
    entry.clients += 1;
    return sandbox;
  }

  /** Release one session's claim on its run's retained sandbox; stops the compute (keeping the disk) once the last claim is gone. */
  async function releaseRun(runId: string): Promise<void> {
    const entry = retained.get(runId);
    if (!entry) return;
    entry.clients = Math.max(0, entry.clients - 1);
    if (entry.clients > 0) return;
    retained.delete(runId);
    const sandbox = await entry.pending.catch(() => undefined);
    await sandbox?.release().catch(() => undefined);
  }

  function releaseSession(session: Session): void {
    if (session.released) return;
    session.released = true;
    void releaseRun(session.runId);
  }

  async function open(message: AttachOpenMessage): Promise<void> {
    const { attachId, runId, config, cols, rows } = message;
    const fail = (text: string): void => send({ type: "attach-error", attachId, message: text });

    const run = getRun(runId);
    if (!run) {
      fail(`no resumable sandbox for run ${runId} (this worker has not executed it since it last started)`);
      return;
    }
    const retainedUntil = run.sandbox.retainedUntil;
    if (!retainedUntil || Date.parse(retainedUntil) <= Date.now()) {
      fail("the run's sandbox is no longer available; it was cleaned up when the retention window ended");
      return;
    }
    if (!run.agentSessionId) {
      fail("no agent session id was captured for this run; interactive resume supports Claude runs only");
      return;
    }
    if (run.sandbox.provider && run.sandbox.provider !== "bwrap") {
      fail(`this run's sandbox (${run.sandbox.provider}) cannot be reattached; only bwrap sandboxes are supported`);
      return;
    }

    const session: Session = { runId, released: false };
    sessions.set(attachId, session);

    try {
      const env = collectAgentEnv(config);
      env.PLAYWRIGHT_BROWSERS_PATH = await playwrightBrowsersPath(provider.name);
      const sandbox = await bootOrShare(runId, env);

      // Reinstalled fresh on every attach (not just the first session on a
      // shared boot): cheap, and keeps credentials current if they rotated
      // since the sandbox was retained.
      const provisioned = await provisionCredentials({
        sandbox,
        runId,
        env,
        codexAuthJson: config.agent.codexAuthJson || undefined,
        grokAuthJson: config.agent.grokAuthJson || undefined,
        githubToken: config.github.token || undefined,
      });
      const scriptPath = join(WORKSPACES_DIR, runId, "brevi-resume.sh");
      await sandbox.writeFile(
        scriptPath,
        buildResumeScript({
          workspacePath: sandbox.workspacePath,
          homePath: sandbox.homePath,
          profilePath: provisioned.profilePath,
          command: config.agent.command,
          sessionId: run.agentSessionId,
        }),
      );
      await sandbox.exec("chmod", ["755", scriptPath]);

      const launch = sandbox.wrap("/bin/sh", [scriptPath], undefined, { newSession: false });
      const file = launch.file;
      const args = launch.args;

      if (!sessions.has(attachId)) {
        // attach-close raced the boot; nothing left to spawn into.
        releaseSession(session);
        return;
      }
      // launch.env is the same allowlist exec uses (no worker credential, HOME
      // is the workspace). wrap also --clearenv/--setenv so a forgotten env
      // here cannot leak the host environment into the session.
      session.pty = spawn(file, args, {
        name: "xterm-256color",
        cols,
        rows,
        env: { ...launch.env, TERM: "xterm-256color" },
      });
      session.pty.onData((data) => send({ type: "attach-data", attachId, data }));
      session.pty.onExit(({ exitCode }) => {
        session.pty = undefined;
        sessions.delete(attachId);
        send({ type: "attach-exit", attachId, code: exitCode });
        releaseSession(session);
      });
    } catch (error) {
      sessions.delete(attachId);
      releaseSession(session);
      fail(errorMessage(error));
    }
  }

  function input(attachId: string, data: string): void {
    sessions.get(attachId)?.pty?.write(data);
  }

  function resize(attachId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) sessions.get(attachId)?.pty?.resize(cols, rows);
  }

  function close(attachId: string): void {
    const session = sessions.get(attachId);
    if (!session) return;
    sessions.delete(attachId);
    session.pty?.kill();
    session.pty = undefined;
    releaseSession(session);
  }

  function closeAll(): void {
    // Safe to delete the current (or an already-visited) key while a Map
    // iterator is live; nothing here adds a session mid-loop.
    for (const attachId of sessions.keys()) close(attachId);
  }

  return { open, input, resize, close, closeAll };
}

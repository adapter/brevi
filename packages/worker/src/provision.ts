import { join } from "node:path";
import { WORKSPACES_DIR } from "@brevi/shared";
import type { Sandbox } from "@brevi/sandbox";
import { isSafePathSegment } from "@brevi/orchestrator/internal";
import { buildCredentialProfile, buildGitAskpass } from "./resume.js";

export interface ProvisionedCredentials {
  /** Absolute path of the installed credential profile (POSIX sh, mode 600). */
  profilePath: string;
  /** Stable Codex state directory (auth.json when a ChatGPT login is connected, rollout/session history). */
  codexHome: string;
  /** Stable Grok state directory (auth.json when a Grok CLI login is connected). */
  grokHome: string;
}

/**
 * Installs agent credentials as sandbox-wide state (a shell profile plus, for
 * a Codex ChatGPT login, its auth.json) instead of passing them only as
 * per-exec env. Credentials that travel solely as exec env leave any other
 * shell in the sandbox, an attached terminal's included, looking logged out.
 * Reinstalled fresh by every caller, so rotated or reconnected credentials
 * take effect on the next attach without recreating the sandbox, and written
 * only onto the sandbox's own disk, so retention cleanup scrubs them with the
 * rest of the sandbox.
 */
export async function provisionCredentials(options: {
  sandbox: Sandbox;
  runId: string;
  env: Record<string, string>;
  /** Raw Codex ChatGPT auth.json contents, when that credential is connected. */
  codexAuthJson?: string;
  /** Raw Grok CLI auth.json contents, when that credential is connected. */
  grokAuthJson?: string;
  /**
   * Connected GitHub token, installed as a git askpass helper so attached
   * shells can push. Passed by the attach flow only, never at run time: the
   * running agent must not hold push credentials.
   */
  githubToken?: string;
}): Promise<ProvisionedCredentials> {
  const { sandbox, runId, env, codexAuthJson, grokAuthJson, githubToken } = options;
  // The attach flow's runId originates in a client request; re-checked here
  // (the server and store boundaries validate it too) so a hostile id can
  // never be joined into a host-side path that escapes WORKSPACES_DIR.
  if (!isSafePathSegment(runId)) throw new Error(`unsafe run id: ${JSON.stringify(runId)}`);
  const ssh = sandbox.connection().kind === "ssh";
  // Firecracker (ssh): VM state in the guest, outside the workspace so the
  // run's tree stays clean. The guest is Ubuntu, so root login shells source
  // /etc/profile.d/*.sh, and /root/.codex is the Codex CLI's default
  // CODEX_HOME, so plain `codex` in a shell finds it even without the export.
  // Process provider: beside (not inside) the workspace under the run's
  // directory on the host, so both are removed with the run's directory by
  // destroy()/discard()/the workspace sweep and never touch the host's real
  // shell profile.
  const profilePath = ssh ? "/etc/profile.d/brevi-credentials.sh" : join(WORKSPACES_DIR, runId, "brevi-credentials.sh");
  const codexHome = ssh ? "/root/.codex" : join(WORKSPACES_DIR, runId, "codex-home");
  const grokHome = ssh ? "/root/.grok" : join(WORKSPACES_DIR, runId, "grok-home");
  const askpassPath = ssh ? "/root/brevi-git-askpass.sh" : join(WORKSPACES_DIR, runId, "brevi-git-askpass.sh");

  // The Codex home always exists and is always exported, even without a
  // ChatGPT login: on the process provider an unset CODEX_HOME would fall
  // back to the host's real ~/.codex, leaking its login into the sandbox and
  // the run's rollout history into the host.
  const authPath = `${codexHome}/auth.json`;
  if (codexAuthJson) {
    await sandbox.writeFile(authPath, codexAuthJson);
    await sandbox.exec("chmod", ["700", codexHome]);
    await sandbox.exec("chmod", ["600", authPath]);
  } else {
    // Only the login file goes when ChatGPT auth is absent (disconnected, or
    // replaced by an API key): the home also holds Codex rollout/session
    // history that the usage reader consumes, which a credential switch must
    // not destroy.
    await sandbox.exec("rm", ["-f", authPath]);
    await sandbox.exec("mkdir", ["-p", codexHome]);
    await sandbox.exec("chmod", ["700", codexHome]);
  }

  // Same isolation as CODEX_HOME: an unset GROK_HOME on the process provider
  // would fall back to the host's real ~/.grok.
  const grokAuthPath = `${grokHome}/auth.json`;
  if (grokAuthJson) {
    await sandbox.writeFile(grokAuthPath, grokAuthJson);
    await sandbox.exec("chmod", ["700", grokHome]);
    await sandbox.exec("chmod", ["600", grokAuthPath]);
  } else {
    await sandbox.exec("rm", ["-f", grokAuthPath]);
    await sandbox.exec("mkdir", ["-p", grokHome]);
    await sandbox.exec("chmod", ["700", grokHome]);
  }

  if (githubToken) {
    await sandbox.writeFile(askpassPath, buildGitAskpass(githubToken));
    await sandbox.exec("chmod", ["700", askpassPath]);
  } else {
    // A token installed by an earlier attach must not outlive its
    // configuration (or leak into a run-time provisioning pass).
    await sandbox.exec("rm", ["-f", askpassPath]);
  }

  await sandbox.writeFile(
    profilePath,
    buildCredentialProfile({
      env,
      profilePath,
      codexHome,
      grokHome,
      gitAskpassPath: githubToken ? askpassPath : undefined,
    }),
  );
  await sandbox.exec("chmod", ["600", profilePath]);

  return { profilePath, codexHome, grokHome };
}

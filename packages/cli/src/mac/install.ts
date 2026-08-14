import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@brevi/orchestrator";
import { resolveBinary } from "@brevi/sandbox";
import { BREVI_HOME, type BreviConfig } from "@brevi/shared";
import { confirm, intro, log, outro, spinner } from "@clack/prompts";
import pc from "picocolors";
import { errorMessage, exitOnCancel } from "../lib/util.js";
import { readPackageVersion } from "../lib/version.js";
import {
  installLaunchAgent,
  isEphemeralCliPath,
  launchAgentInstalled,
  removeLaunchAgent,
  suspendLaunchAgent,
  SUPERVISOR_LOG_PATH,
} from "./launchd.js";
import {
  findLimactl,
  LIMA_BREW_PACKAGE,
  limaCreate,
  limaDelete,
  limaShell,
  limaStart,
  limaStatus,
  limaStop,
} from "./limactl.js";
import { detectMacHostFacts, evaluateMacHostSupport, MAC_WORKER_REQUIREMENT } from "./preflight.js";
import {
  DEFAULT_MAC_VM_NAME,
  forgetMacVmSettings,
  loadMacVmSettings,
  normalizeMacVmSettings,
  saveMacVmSettings,
  type MacVmSettings,
} from "./state.js";
import {
  assertValidLimaInstanceName,
  guestHostUrl,
  sameHostOrigin,
  GUEST_NETWORK_SERVICE_NAME,
  GUEST_SERVICE_NAME,
  isUsableHostUrl,
  LIMA_HOST_GATEWAY,
  renderLimaTemplate,
  renderProvisionScript,
} from "./template.js";

/**
 * The install/uninstall/status flows for the managed macOS worker VM, in the
 * `@clack/prompts` house style of `packages/cli/src/commands/setup.ts`.
 * `installMacWorker` guards its hardware gate (`evaluateMacHostSupport`)
 * ahead of every filesystem write, so a refused install leaves nothing
 * behind: that ordering is the acceptance criterion, not just a nicety.
 */

export interface MacInstallOptions {
  hostUrl?: string;
  token?: string;
  cpus?: number;
  memoryGiB?: number;
  diskGiB?: number;
  idleStopMinutes?: number;
  concurrency?: number;
  workerName?: string;
  assumeYes: boolean;
}

const MAC_DIR = join(BREVI_HOME, "mac");

function runCommand(command: string, args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) {
        resolvePromise({ exitCode: 0, stderr: stderr ?? "" });
        return;
      }
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      resolvePromise({ exitCode: typeof code === "number" ? code : 1, stderr: stderr ?? err.message });
    });
  });
}

/** Resolves limactl, offering a Homebrew install when it's missing. Undefined when it could not be resolved. */
async function ensureLimactl(assumeYes: boolean): Promise<string | undefined> {
  const existing = await findLimactl();
  if (existing !== undefined) return existing;

  const brew = await resolveBinary("brew");
  if (brew === undefined) {
    log.error(`Lima (${LIMA_BREW_PACKAGE}) is not installed, and Homebrew is not available to install it.`);
    log.info(`Install it yourself (${pc.cyan("https://lima-vm.io/docs/installation/")}), then re-run this command.`);
    return undefined;
  }

  const proceed =
    assumeYes ||
    exitOnCancel(
      await confirm({ message: `Install ${LIMA_BREW_PACKAGE} with Homebrew now?`, initialValue: true }),
    );
  if (!proceed) {
    log.warn(`Skipped; brevi mac install cannot proceed without ${LIMA_BREW_PACKAGE}.`);
    return undefined;
  }

  const s = spinner();
  s.start(`Installing ${LIMA_BREW_PACKAGE} with Homebrew`);
  const result = await runCommand(brew, ["install", LIMA_BREW_PACKAGE]);
  if (result.exitCode !== 0) {
    s.error(`brew install ${LIMA_BREW_PACKAGE} failed (exit ${result.exitCode}).`);
    if (result.stderr.trim()) log.error(result.stderr.trim());
    return undefined;
  }
  s.stop(`Installed ${LIMA_BREW_PACKAGE}.`);

  const resolved = await findLimactl();
  if (resolved === undefined) log.error(`${LIMA_BREW_PACKAGE} still isn't on PATH after the install.`);
  return resolved;
}

/**
 * Which of the local host's two listeners the guest will be able to dial, as
 * a port on this machine. The fleet listener is preferred when it is on: it
 * exists precisely so a worker on another machine can reach the worker
 * channel without the unauthenticated dashboard API coming with it, and the
 * guest VM is another machine as far as the network is concerned.
 *
 * Undefined when both listeners are loopback-only, which is the default. That
 * is not something this command can paper over: a loopback bind refuses the
 * guest no matter what URL it is handed, so the install has to say so instead
 * of provisioning a worker that can never enroll.
 */
function guestReachableListener(config: BreviConfig): { port: number; via: string } | undefined {
  if (config.fleet.host !== "" && !isLoopbackBind(config.fleet.host)) {
    return { port: config.fleet.port, via: `the worker channel's own listener (fleet.host ${config.fleet.host})` };
  }
  if (!isLoopbackBind(config.server.host)) {
    return { port: config.server.port, via: `the dashboard listener (server.host ${config.server.host})` };
  }
  return undefined;
}

/** A bind address that accepts nothing from outside this machine. A wildcard bind ("0.0.0.0", "::") is not one. */
function isLoopbackBind(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Where the guest dials and what it enrolls with. `--host` falls back to this
 * machine's own config, which is what you want when the Mac is also the host;
 * `--token` has no fallback, because a pairing token is minted on demand and
 * single-use (see the Workers page). The one case that needs no token is a
 * re-install over a guest already enrolled *with that same host*: it holds a
 * durable credential of its own, and reconnects with that.
 *
 * Which host is the whole question. A credential is scoped to the origin that
 * issued it, and the guest refuses to present one anywhere else (see
 * `enrollmentFor` in @brevi/worker), so pointing an enrolled VM at a different
 * orchestrator without a token would provision a guest that can neither enroll
 * nor fall back, while this command reported success. That is a fresh
 * enrollment, and it is refused here rather than discovered later from a
 * worker that never appears.
 *
 * The URL returned is always the Mac's own view of the host, since that is
 * what the supervisor polls; `renderGuestService` translates it into the
 * guest's view (see `guestHostUrl`).
 */
async function resolveHostAndToken(
  options: MacInstallOptions,
  previous: MacVmSettings | undefined,
): Promise<{ hostUrl: string; token: string } | undefined> {
  let hostUrl = options.hostUrl;
  if (hostUrl === undefined) {
    const config = await loadConfig().catch((err: unknown) => {
      log.error(errorMessage(err));
      log.info(`Run ${pc.cyan("npx @brevi/cli")} to create one, or pass --host directly.`);
      return undefined;
    });
    if (config === undefined) return undefined;

    const listener = guestReachableListener(config);
    if (listener === undefined) {
      log.error("This host only listens on loopback, so the guest VM cannot reach it.");
      log.info(
        `The VM is a separate machine on its own network: it dials in over ${pc.cyan(LIMA_HOST_GATEWAY)}, which a loopback-only listener refuses. Open Configuration > Workers on this host and set the worker channel's bind address to ${pc.cyan("0.0.0.0")}, then re-run this command. Or pass ${pc.cyan("--host")} with an address the VM can dial.`,
      );
      return undefined;
    }
    log.step(`The guest will dial this Mac on port ${listener.port}, through ${listener.via}.`);
    hostUrl = `http://localhost:${listener.port}`;
  } else if (guestHostUrl(hostUrl) !== hostUrl) {
    // An explicit --host naming loopback: the port is the caller's to choose,
    // so this is a warning rather than the refusal above, but the rewrite is
    // worth saying out loud since the guest will not be dialling what was
    // typed, and only a non-loopback listener there will answer it.
    log.warn(
      `--host names this machine, so the guest will dial ${pc.cyan(guestHostUrl(hostUrl))} instead. That is answered only if the orchestrator listens on more than loopback.`,
    );
  }

  if (options.token === undefined) {
    // The host the guest's existing credential was issued by, or undefined
    // when there is no enrollment to carry over in the first place.
    const enrolledWith = (previous?.credential ?? "") === "" ? undefined : (previous?.hostUrl ?? "");
    if (enrolledWith !== undefined && !sameHostOrigin(enrolledWith, hostUrl)) {
      log.error(`This VM is enrolled with ${enrolledWith}, and would now be pointed at ${hostUrl}.`);
      log.info(
        `A worker credential only works with the host that issued it, so moving this VM to another orchestrator is a fresh enrollment: mint a pairing token there (Configuration > Workers, "Add a worker") and pass it with ${pc.cyan("--token")}.`,
      );
      return undefined;
    }
    if (enrolledWith === undefined) {
      log.error("No pairing token given.");
      log.info(
        `Open Configuration > Workers on the host and use "Add a worker": it mints a single-use pairing token. Pass it here with ${pc.cyan("--token")}.`,
      );
      return undefined;
    }
  }
  return { hostUrl, token: options.token ?? "" };
}

/**
 * Create the Lima instance, or reuse and reconfigure an existing one. Split
 * out of `installMacWorker` so its several failure paths all land in one
 * place: the launchd supervisor has been stood down by then, and it has to be
 * put back whichever way this goes.
 */
async function bringUpGuest(
  settings: MacVmSettings,
  templatePath: string,
  onLine: (line: string) => void,
): Promise<boolean> {
  try {
    const existingStatus = await limaStatus(settings.name);
    if (existingStatus === "Missing") {
      log.step(`Creating the Lima instance "${settings.name}".`);
      await limaCreate(settings.name, templatePath, onLine);
      return true;
    }
    // Lima owns an existing instance's configuration (its own copy of the
    // template under ~/.lima/<name>), so a second install reuses the VM as
    // it stands rather than resizing it. Say that plainly instead of
    // implying the new cpu/memory/disk flags took effect.
    log.step(`Lima instance "${settings.name}" already exists (${existingStatus}); reusing it.`);
    log.warn(
      `The existing VM keeps its current cpu, memory and disk allocation. Run ${pc.cyan("brevi mac uninstall")} first to rebuild it with new sizing.`,
    );
    if (existingStatus !== "Running") await limaStart(settings.name, onLine);
    // Lima only runs `provision:` on first boot, so re-run the payload by
    // hand: it is idempotent, and it is what rewrites the guest's config,
    // its host URL and its pairing token when this install changed them.
    log.step("Re-applying the guest provisioning payload.");
    const applied = await limaShell(
      settings.name,
      ["sudo", "bash", "-c", renderProvisionScript({ ...settings, cliVersion: readPackageVersion() })],
      { onLine, timeoutMs: 30 * 60_000 },
    );
    if (applied.exitCode !== 0) {
      log.error(`Guest provisioning failed (exit ${applied.exitCode}).`);
      if (applied.stderr.trim()) log.error(applied.stderr.trim());
      return false;
    }
    return true;
  } catch (err) {
    log.error(errorMessage(err));
    return false;
  }
}

/**
 * An absolute path to a CLI the launchd agent can still execute months from
 * now. The plist is `KeepAlive`, so a path that stops existing does not
 * degrade the supervisor, it makes launchd respawn-fail forever, and a
 * stopped VM then has nothing left to wake it. That is exactly what the
 * documented `npx @brevi/cli` invocation produces: npm unpacks the package
 * into its `_npx` cache and the next `npm cache clean` deletes it.
 *
 * So when the running CLI lives somewhere disposable, its bundle is copied
 * under `~/.brevi/mac/`, beside the Lima template and removed by the same
 * uninstall. A globally installed CLI is already durable and is used where it
 * stands, so upgrading it keeps upgrading the supervisor.
 */
async function durableCliPath(): Promise<string> {
  // realpath, not resolve: argv[1] is usually a `.bin` symlink, and it is the
  // real bundle location that decides whether this copy is disposable.
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  let cliPath: string;
  try {
    cliPath = await realpath(entry);
  } catch {
    cliPath = resolve(entry);
  }
  if (!isEphemeralCliPath(cliPath)) return cliPath;

  // The CLI is a single bundled file next to the assets it ships (dist/app,
  // dist/scripts), so the whole directory travels together.
  const source = dirname(cliPath);
  const target = join(MAC_DIR, "cli");
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  const copied = join(target, basename(cliPath));
  log.step(`Copied the CLI to ${target}, since it is running from a disposable npx cache.`);
  return copied;
}

/** Returns false when the machine or the environment refused the install; the caller exits non-zero. */
export async function installMacWorker(options: MacInstallOptions): Promise<boolean> {
  intro(pc.bgCyan(pc.black(" brevi mac install ")));

  // Argument validation before anything at all, including the hardware
  // probe: a typo in --host is the caller's to fix, and finding out after a
  // Homebrew install and a multi-GB image download (or worse, from a guest
  // worker crash-looping under systemd afterwards) is no way to learn it.
  if (options.hostUrl !== undefined && !isUsableHostUrl(options.hostUrl)) {
    log.error(`--host must be an http(s) URL; got "${options.hostUrl}".`);
    log.info(
      `Include the scheme and the port, e.g. ${pc.cyan("http://192.168.1.5:4400")}. Omit the flag entirely to use this machine's own orchestrator.`,
    );
    outro("Nothing was installed.");
    return false;
  }

  // Hard gate next: nothing below this point may touch disk until the
  // machine passes, so a refused install leaves nothing behind.
  const facts = await detectMacHostFacts();
  const support = evaluateMacHostSupport(facts);
  if (!support.supported) {
    for (const problem of support.problems) log.error(problem);
    log.info(MAC_WORKER_REQUIREMENT);
    outro("This machine cannot run the managed macOS worker VM.");
    return false;
  }

  // Settled before Lima is installed, not after: every way this can fail is
  // a wrong flag or an unreachable listener, and none of them is worth having
  // put a Homebrew package on the machine first.
  const previous = await loadMacVmSettings();
  const resolved = await resolveHostAndToken(options, previous);
  if (resolved === undefined) {
    outro("Nothing was installed.");
    return false;
  }
  const { hostUrl, token } = resolved;

  if ((await ensureLimactl(options.assumeYes)) === undefined) {
    outro("Install Lima and re-run this command.");
    return false;
  }

  const settings = normalizeMacVmSettings(previous ?? {}, {
    cpus: options.cpus,
    memoryGiB: options.memoryGiB,
    diskGiB: options.diskGiB,
    idleStopMinutes: options.idleStopMinutes,
    concurrency: options.concurrency,
    hostUrl,
    token,
    // A pasted token is a deliberate re-enrollment: the guest redeems it and
    // comes back as a new worker, on this host or another one, so whatever
    // enrollment we had copied off it is about to be stale. Drop it here and
    // let the supervisor learn the new one, rather than polling as an identity
    // this VM no longer has. The shutdown reservation goes with it: it names a
    // worker that is about to stop existing.
    ...(token === "" ? {} : { workerId: "", credential: "", selfDrained: false }),
    workerName: options.workerName ?? hostname(),
    name: DEFAULT_MAC_VM_NAME,
  });

  try {
    assertValidLimaInstanceName(settings.name);
  } catch (err) {
    log.error(errorMessage(err));
    outro("Invalid Lima instance name.");
    return false;
  }
  await saveMacVmSettings(settings);

  await mkdir(MAC_DIR, { recursive: true });
  const templatePath = join(MAC_DIR, `lima-${settings.name}.yaml`);
  const template = renderLimaTemplate({ ...settings, cliVersion: readPackageVersion() });
  await writeFile(templatePath, template, { mode: 0o600 });
  log.step(`Wrote the Lima template to ${templatePath}.`);

  log.info(
    "Provisioning the guest downloads a multi-GB Ubuntu image and runs `brevi setup --yes` inside it; this can take several minutes.",
  );
  const onLine = (line: string) => console.log(pc.dim(`  ${line}`));

  // Stand the running supervisor down for the duration. It polls on its own
  // schedule, and an idle threshold reached while `limactl shell` is midway
  // through the payload below would stop the VM out from under it and leave
  // the guest half configured. Restored (or installed for the first time)
  // once the guest is done, whether or not that succeeded.
  if (await suspendLaunchAgent()) {
    log.step("Paused the launchd supervisor while the VM is reconfigured.");
  }

  const provisioned = await bringUpGuest(settings, templatePath, onLine);

  const nodePath = process.execPath;
  let agentError: string | undefined;
  try {
    await installLaunchAgent({ nodePath, cliPath: await durableCliPath() });
  } catch (err) {
    agentError = errorMessage(err);
  }

  if (!provisioned) {
    outro("Could not bring up the guest VM.");
    return false;
  }
  log.success("The guest VM is up and provisioned.");

  if (agentError !== undefined) {
    log.error(`Could not install the launchd agent: ${agentError}`);
    outro("The VM is up, but the launchd supervisor could not be installed.");
    return false;
  }
  log.success("Installed the launchd agent that supervises the VM.");

  outro(
    [
      "The macOS worker is installed.",
      "The guest worker registers with the host on its own once it finishes booting.",
      settings.idleStopMinutes === 0
        ? "Auto-stop is disabled, so the VM keeps running until you stop it."
        : `The VM stops automatically after ${settings.idleStopMinutes} minute(s) idle.`,
      "A queued run on the host wakes it back up.",
    ].join("\n"),
  );
  return true;
}

export async function uninstallMacWorker(options: { assumeYes: boolean }): Promise<boolean> {
  intro(pc.bgCyan(pc.black(" brevi mac uninstall ")));

  const settings = await loadMacVmSettings();
  const name = settings?.name ?? DEFAULT_MAC_VM_NAME;

  if (!options.assumeYes) {
    const proceed = exitOnCancel(
      await confirm({
        message: `Remove the managed macOS worker VM ("${name}"), its launchd agent, and all saved state?`,
        initialValue: false,
      }),
    );
    if (!proceed) {
      outro("Nothing removed.");
      return false;
    }
  }

  let failed = false;

  try {
    const removed = await removeLaunchAgent();
    log.step(removed ? "Removed the launchd agent." : "No launchd agent was installed.");
  } catch (err) {
    log.error(`Could not remove the launchd agent: ${errorMessage(err)}`);
    failed = true;
  }

  try {
    const status = await limaStatus(name);
    if (status === "Missing") {
      log.step(`No Lima instance named "${name}" was found.`);
    } else {
      if (status === "Running") await limaStop(name).catch(() => undefined);
      await limaDelete(name);
      log.step(`Deleted the Lima instance "${name}".`);
    }
  } catch (err) {
    log.error(`Could not delete the Lima instance "${name}": ${errorMessage(err)}`);
    failed = true;
  }

  try {
    const existed = existsSync(MAC_DIR);
    await rm(MAC_DIR, { recursive: true, force: true });
    log.step(existed ? `Removed ${MAC_DIR}.` : `${MAC_DIR} did not exist.`);
  } catch (err) {
    log.error(`Could not remove ${MAC_DIR}: ${errorMessage(err)}`);
    failed = true;
  }

  const hadSettings = settings !== undefined;
  try {
    await forgetMacVmSettings();
    log.step(hadSettings ? "Forgot the saved VM settings." : "No saved VM settings were found.");
  } catch (err) {
    log.error(`Could not remove the saved VM settings: ${errorMessage(err)}`);
    failed = true;
  }

  try {
    const existed = existsSync(SUPERVISOR_LOG_PATH);
    await rm(SUPERVISOR_LOG_PATH, { force: true });
    log.step(existed ? `Removed ${SUPERVISOR_LOG_PATH}.` : `${SUPERVISOR_LOG_PATH} did not exist.`);
  } catch (err) {
    log.error(`Could not remove ${SUPERVISOR_LOG_PATH}: ${errorMessage(err)}`);
    failed = true;
  }

  if (failed) {
    outro("Uninstall finished with errors; see above.");
    return false;
  }
  outro("The macOS worker VM, its launchd agent, and all saved state have been removed.");
  return true;
}

/** Print what is installed and what the VM is doing right now. */
export async function reportMacWorkerStatus(): Promise<void> {
  intro(pc.bgCyan(pc.black(" brevi mac status ")));

  const settings = await loadMacVmSettings();
  if (settings === undefined) {
    log.info(`The macOS worker is not installed. Run ${pc.cyan("brevi mac install")} to set it up.`);
    outro("Not installed.");
    return;
  }

  log.info(
    [
      `VM name: ${settings.name}`,
      `cpus: ${settings.cpus}`,
      `memory: ${settings.memoryGiB} GiB`,
      `disk: ${settings.diskGiB} GiB`,
      `idle stop: ${settings.idleStopMinutes === 0 ? "disabled" : `${settings.idleStopMinutes} minute(s)`}`,
      `host: ${settings.hostUrl || "(none)"}`,
      `worker name: ${settings.workerName || "(none)"}`,
      `worker id: ${settings.workerId || "not registered yet"}`,
    ].join("\n"),
  );

  const status = await limaStatus(settings.name);
  log.info(`Lima status: ${status}`);

  const agentLoaded = await launchAgentInstalled();
  log.info(`launchd agent: ${agentLoaded ? "loaded" : "not loaded"}`);

  if (status === "Running") {
    // The networking unit is reported alongside the worker rather than folded
    // into it: the worker Requires= it, so a worker that is down because the
    // networking failed looks identical to one that is down on its own, and
    // those are very different things to go and fix.
    for (const unit of [GUEST_NETWORK_SERVICE_NAME, GUEST_SERVICE_NAME]) {
      const result = await limaShell(settings.name, ["sudo", "systemctl", "is-active", unit]);
      const guestState = result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`;
      log.info(`Guest service ${unit}: ${guestState}`);
    }
  }

  outro("Done.");
}

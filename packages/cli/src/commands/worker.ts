import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chown, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@brevi/orchestrator";
import { installRootfs, locateRootfs, resolveBinary } from "@brevi/sandbox";
import { CONFIG_PATH, firecrackerConfigSchema, WORKER_MAX_CONCURRENCY, type FirecrackerConfig } from "@brevi/shared";
import { enrollmentFor, runWorker } from "@brevi/worker";
import { Option, type Command } from "commander";
import pc from "picocolors";
import { errorMessage } from "../lib/util.js";
import { compareVersions, fetchLatestVersion } from "../lib/update.js";
import { readPackageVersion } from "../lib/version.js";
import { installWorkerBinary, isStandaloneBinary } from "../lib/worker-binary.js";

const SYSTEMD_UNIT_PATH = "/etc/systemd/system/brevi-worker.service";
/** The system account the installer (packages/worker/scripts/install.sh) runs the daemon as. */
const SERVICE_USER = "brevi";

interface WorkerCommandOptions {
  host?: string;
  token?: string;
  name?: string;
  concurrency?: string;
}

/**
 * Identity `brevi start`'s orchestrator mints and injects into the localhost
 * worker child it spawns, so it enrolls with no pairing ceremony. Process
 * provenance from the spawning parent (like BREVI_SUPERVISOR_PID), not
 * persistent configuration.
 */
function injectedEnrollment(): { workerId: string; credential: string } | undefined {
  const workerId = process.env.BREVI_WORKER_ID;
  const credential = process.env.BREVI_WORKER_CREDENTIAL;
  return workerId && credential ? { workerId, credential } : undefined;
}

/** Pid of the injecting supervisor, for runWorker's watchdog; undefined when absent or invalid. */
function injectedSupervisorPid(): number | undefined {
  const raw = process.env.BREVI_WORKER_SUPERVISOR_PID;
  const pid = raw ? Number(raw) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

interface UpdateCommandOptions {
  check?: boolean;
  version?: string;
  /** Set only on the re-exec that a freshly installed binary performs on itself. */
  resumeAfterBinary?: boolean;
}

export function registerWorkerCommand(program: Command): void {
  // `worker` takes its own options (--host, --token, ...) and also carries the
  // `update` subcommand. Commander only routes an option past a parent that
  // declares options of its own once positional options are enabled the whole
  // way down from the root, otherwise the parent's parseOptions eagerly claims
  // the rest of the argv before the subcommand ever sees it (see
  // https://github.com/tj/commander.js/blob/master/docs/options-taking-argument.md,
  // "Positional options"). None of brevi's other commands take options
  // before their own name, so this has no effect on them.
  program.enablePositionalOptions();

  const workerCommand = program
    .command("worker")
    .enablePositionalOptions()
    .description("Enroll this machine as a worker, or reconnect an enrolled one")
    // Required in practice, with no fallback to the local config: which brevi
    // instance a worker belongs to is the host's business, not something this
    // machine's own config (if it even has one) could know. Enforced in the
    // action rather than with requiredOption, because commander checks a
    // parent's mandatory options when a subcommand parses too, which would
    // make `brevi worker update` (which needs no host at all) unrunnable.
    .option("--host <url>", "the brevi host to work for, e.g. http://192.168.1.5:4400")
    .option(
      "--token <token>",
      "single-use pairing token minted on the host's Workers page; needed only to enroll this machine, or to enroll it again after its credential was revoked",
    )
    .option(
      "--name <name>",
      "name to enroll under (default: this machine's hostname); the host keeps its own name for this worker afterwards, so later renames happen on the dashboard",
    )
    .option(
      "--concurrency <n>",
      "how many dispatched runs to execute at once (default: the local config's sandbox.concurrency, or 1 on a machine with no brevi config)",
    )
    .action(async (options: WorkerCommandOptions) => {
      if (!options.host) {
        console.error(pc.red("✖ --host is required: `brevi worker --host <url>` names the brevi instance to work for."));
        console.error(
          pc.dim(
            '  Open Configuration > Workers on that host and use "Add a worker": it shows the exact command to run here.',
          ),
        );
        process.exit(1);
      }

      const concurrency = options.concurrency !== undefined ? parseConcurrency(options.concurrency) : undefined;
      const enrollment = injectedEnrollment();

      // Enrollment is the only way onto a host's fleet, and a pairing token is
      // the only way to enroll by hand: without one, without an identity a
      // supervisor injected (see injectedEnrollment above), and without a
      // credential an earlier enrollment with this host left behind, there is
      // nothing to connect with. Said here rather than after the sandbox
      // provider has been resolved, which can take minutes on a first run.
      if (!options.token && !enrollment && !(await enrollmentFor(options.host))) {
        console.error(pc.red(`✖ This machine is not enrolled with ${options.host}, and no --token was given.`));
        console.error(
          pc.dim(
            '  Open Configuration > Workers on that host and use "Add a worker": it mints a pairing token and shows the exact command to run here.',
          ),
        );
        process.exit(1);
      }

      try {
        await runWorker({
          hostUrl: options.host,
          token: options.token,
          name: options.name,
          concurrency,
          enrollment,
          supervisorPid: injectedSupervisorPid(),
        });
      } catch (err) {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        process.exit(1);
      }
    });

  workerCommand
    .command("update")
    .description(
      "Upgrade an installed worker's binary and its prebuilt rootfs image in place, without touching ~/.brevi/config.json or ~/.brevi/worker.json, so enrollment survives",
    )
    .option("--check", "only report whether a newer version exists, without installing")
    .option("--version <v>", "install this exact @brevi/cli version instead of the latest")
    // Internal: how a just-installed binary is handed the rest of its own
    // update (see runWorkerUpdate). Hidden because running it by hand does
    // nothing useful: it skips the binary step and assumes it was replaced.
    .addOption(new Option("--resume-after-binary", "finish an update whose binary step already ran").hideHelp())
    .action(async (options: UpdateCommandOptions) => {
      await runWorkerUpdate(options);
    });
}

/**
 * Validates `brevi worker --concurrency` against WORKER_MAX_CONCURRENCY, the wire
 * protocol's registration ceiling, exiting on failure. Checked here rather than left
 * to the host, which would simply refuse the registration.
 */
function parseConcurrency(raw: string): number {
  const concurrency = Number(raw);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > WORKER_MAX_CONCURRENCY) {
    console.error(
      pc.red(`✖ --concurrency must be an integer between 1 and ${WORKER_MAX_CONCURRENCY}, got "${raw}".`),
    );
    process.exit(1);
  }
  return concurrency;
}

/**
 * Upgrades an installed worker in place: the binary first, then the rootfs image
 * that release expects, then the service.
 *
 * The two halves deliberately run in two processes. Replacing the executable does
 * not replace the running one (rename repoints the directory entry; this process
 * keeps its own inode), so everything after the swap would otherwise be the OLD
 * release's code deciding what the NEW release needs. That is wrong the moment a
 * release changes the rootfs contract: the old manifest parser rejects the new
 * image's ROOTFS_VERSION and the update stops with the binary already replaced and
 * no matching image on disk. So once the binary lands, this process re-execs it
 * with --resume-after-binary and does nothing further itself.
 */
async function runWorkerUpdate(options: UpdateCommandOptions): Promise<void> {
  const current = readPackageVersion();

  // The re-exec: this process IS the newly installed release, so there is no
  // version to resolve and no binary step to run, and the restart at the end is
  // owed regardless of whether the rootfs needed installing too.
  if (options.resumeAfterBinary) {
    await finishWorkerUpdate({ installedVersion: current, binaryChanged: true });
    return;
  }

  let target: string;
  try {
    target = options.version ?? (await fetchLatestVersion());
  } catch (err) {
    console.error(pc.red(`✖ Could not reach the npm registry: ${errorMessage(err)}`));
    process.exit(1);
  }

  const upToDate = compareVersions(current, target) >= 0;

  if (options.check) {
    if (upToDate) {
      console.log(pc.green(`✔ worker is up to date (${pc.bold(current)})`));
      return;
    }
    console.log(pc.yellow(`! Update available: ${pc.bold(current)} → ${pc.bold(target)}`));
    process.exit(1);
  }

  const forceVersion = options.version !== undefined;
  let installedVersion = current;
  let binaryChanged = false;

  if (upToDate && !forceVersion) {
    console.log(pc.green(`✔ worker binary is up to date (${pc.bold(current)})`));
  } else if (!isStandaloneBinary()) {
    console.log(
      pc.yellow(
        "! This brevi was installed with npm; `brevi worker update` cannot replace its own binary in place.",
      ),
    );
    console.log(pc.dim("  Run `brevi update` to upgrade it."));
  } else {
    // process.execPath, never process.argv[1]: inside a standalone build the
    // latter is the entry module's path in Bun's virtual filesystem
    // ("/$bunfs/root/brevi"), which is what isStandaloneBinary() detects but
    // is not a real file. execPath is the executable on disk, the one that has
    // to be replaced.
    const targetPath = process.execPath;
    if (!targetPath) {
      console.error(pc.red("✖ Could not work out this binary's own path."));
      process.exit(1);
    }
    console.log(`Downloading worker binary ${pc.bold(target)}...`);
    let lastMib = -1;
    try {
      await installWorkerBinary({
        cliVersion: target,
        targetPath,
        onProgress: (bytes) => {
          const mib = Math.floor(bytes / (1024 * 1024));
          if (mib !== lastMib) {
            lastMib = mib;
            console.log(pc.dim(`  ...${mib} MiB`));
          }
        },
      });
      installedVersion = target;
      binaryChanged = true;
      console.log(pc.green(`✔ Installed brevi ${target} to ${targetPath}`));
    } catch (err) {
      console.error(pc.red(`✖ Could not install the worker binary: ${errorMessage(err)}`));
      process.exit(1);
    }

    // Everything left (which rootfs image this release wants, how to validate it,
    // when to restart) is the new binary's business, so hand over to it.
    process.exit(await resumeInNewBinary(targetPath, target));
  }

  await finishWorkerUpdate({ installedVersion, binaryChanged });
}

/**
 * Re-execs the freshly installed binary to finish the update, inheriting stdio so
 * its output is simply the rest of this command's output. Resolves to the exit
 * code to leave with; a binary that cannot be spawned at all is reported as the
 * half-done state it is, since the executable on disk has already been replaced.
 */
function resumeInNewBinary(targetPath: string, version: string): Promise<number> {
  console.log(pc.dim(`  Continuing with brevi ${version} (${targetPath})...`));
  return new Promise((resolve) => {
    const child = spawn(targetPath, ["worker", "update", "--resume-after-binary"], { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(pc.red(`✖ Could not run the installed binary ${targetPath}: ${errorMessage(err)}`));
      console.error(
        pc.dim("  The binary is updated but its rootfs image is not; re-run `brevi worker update` to finish."),
      );
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * The half of the update that must run as the release being installed: resolve
 * the service user's paths, make sure that release's rootfs image is present,
 * and restart the daemon so it picks both up.
 */
async function finishWorkerUpdate({
  installedVersion,
  binaryChanged,
}: {
  installedVersion: string;
  binaryChanged: boolean;
}): Promise<void> {
  const service = await resolveServiceContext();
  if (service !== undefined) {
    console.log(pc.dim(`  Acting on the ${SERVICE_USER} service user: ${service.configPath}, ${service.cacheDir}`));
  }

  const config = await loadConfig(service?.configPath).catch(() => undefined);
  const firecracker: FirecrackerConfig = config?.sandbox.firecracker ?? firecrackerConfigSchema.parse({});

  let rootfsChanged = false;
  const located = await locateRootfs(firecracker, {
    cliVersion: installedVersion,
    cacheDir: service?.cacheDir,
    defaultRootfsPath: service?.defaultRootfsPath,
  });
  if (located.path !== undefined) {
    console.log(pc.green(`✔ rootfs image for brevi ${installedVersion} is installed (${located.path})`));
  } else if (firecracker.rootfs !== "") {
    // A non-empty sandbox.firecracker.rootfs pins the image: locateRootfs checks that
    // path and nothing else, and the daemon boots from it or not at all. Downloading a
    // managed image here would satisfy nobody, since the cache is never consulted while
    // that setting is set: the worker would still refuse to start, only after this
    // command had reported success, restarted it, and spent a multi-gigabyte download
    // on a file nothing reads. An operator who pinned an image owns replacing it, so
    // this refuses rather than quietly overriding the config it was pointed at.
    console.error(
      pc.red(`✖ sandbox.firecracker.rootfs pins ${firecracker.rootfs}, which brevi ${installedVersion} cannot use:`),
    );
    for (const problem of located.problems) console.error(pc.red(`  - ${problem}`));
    console.error(pc.dim(`\n  Nothing was downloaded and the service was not restarted. Either:`));
    console.error(pc.dim(`  - rebuild or replace that image for brevi ${installedVersion}, or`));
    console.error(
      pc.dim(
        `  - clear sandbox.firecracker.rootfs in ${service?.configPath ?? CONFIG_PATH} to let brevi manage the image, which lets this command download the one this release ships with,`,
      ),
    );
    console.error(pc.dim("  then run `brevi worker update` again."));
    if (binaryChanged) {
      console.error(
        pc.dim(`\n  The binary on disk is already brevi ${installedVersion}; the running daemon keeps its old one until`),
      );
      console.error(pc.dim("  the service is restarted, so it stays up on the image it booted with in the meantime."));
    }
    process.exit(1);
  } else {
    console.log(`Downloading rootfs image for brevi ${installedVersion}...`);
    let lastMib = -1;
    try {
      const path = await installRootfs({
        cliVersion: installedVersion,
        baseUrl: firecracker.rootfsBaseUrl,
        cacheDir: service?.cacheDir,
        onProgress: (bytes, totalBytes) => {
          const mib = Math.floor(bytes / (1024 * 1024));
          if (mib !== lastMib) {
            lastMib = mib;
            const total = totalBytes !== undefined ? ` of ${Math.floor(totalBytes / (1024 * 1024))}` : "";
            console.log(pc.dim(`  ...${mib}${total} MiB`));
          }
        },
      });
      rootfsChanged = true;
      console.log(pc.green(`✔ Installed rootfs image to ${path}`));

      // installRootfs just ran as root; chown the version directory it wrote (the image
      // plus its .manifest.json sidecar) to the service user so the daemon, which runs as
      // that user, can still verify, prune, and eventually replace it.
      if (service !== undefined) {
        const versionDir = join(service.cacheDir, installedVersion);
        try {
          await chownRecursive(versionDir, service.uid, service.gid);
        } catch (err) {
          console.error(pc.red(`✖ Could not chown ${versionDir} to ${SERVICE_USER}: ${errorMessage(err)}`));
        }
      }
    } catch (err) {
      console.error(pc.red(`✖ Could not install the rootfs image: ${errorMessage(err)}`));
      process.exit(1);
    }
  }

  if (binaryChanged || rootfsChanged) {
    await restartServiceIfPresent();
  }

  console.log(pc.bold("\nSummary:"));
  console.log(`  binary: ${binaryChanged ? `updated to ${pc.bold(installedVersion)}` : "unchanged"}`);
  console.log(`  rootfs: ${rootfsChanged ? `installed for ${pc.bold(installedVersion)}` : "unchanged"}`);
}

/**
 * Restarts brevi-worker.service when this machine runs one, as root; otherwise prints the
 * command to run. A restart that fails leaves the daemon running the old binary/image
 * despite the update having downloaded the new one, so that case exits the process instead
 * of returning: the caller's success summary must never print over it.
 */
async function restartServiceIfPresent(): Promise<void> {
  if (!existsSync(SYSTEMD_UNIT_PATH)) return;
  if ((await resolveBinary("systemctl")) === undefined) return;

  if (process.getuid?.() !== 0) {
    console.log(pc.yellow("! brevi-worker.service is installed; restart it to run the update:"));
    console.log(pc.dim("  sudo systemctl restart brevi-worker"));
    return;
  }

  console.log("Restarting brevi-worker.service...");
  const code = await runSystemctl(["restart", "brevi-worker"]);
  if (code === 0) {
    console.log(pc.green("✔ Restarted brevi-worker.service"));
    return;
  }

  console.error(pc.red(`✖ systemctl restart brevi-worker exited with code ${code}`));
  console.error(pc.dim("  Check the logs: journalctl -u brevi-worker -n 50 --no-pager"));
  process.exit(1);
}

function runSystemctl(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("systemctl", args, { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

interface ServiceIdentity {
  home: string;
  uid: number;
  gid: number;
}

/**
 * Looks up the service account's uid, gid, and home via `getent passwd`, so a root run can
 * resolve its real ~/.brevi instead of guessing at /var/lib/brevi (an install detail of
 * packages/worker/scripts/install.sh, not something this command should hardcode).
 * Undefined when the account doesn't exist or getent isn't available.
 */
function resolveServiceIdentity(): Promise<ServiceIdentity | undefined> {
  return new Promise((resolve) => {
    execFile("getent", ["passwd", SERVICE_USER], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      // name:passwd:uid:gid:gecos:home:shell
      const fields = stdout.trim().split(":");
      const uid = Number(fields[2]);
      const gid = Number(fields[3]);
      const home = fields[5];
      resolve(Number.isInteger(uid) && Number.isInteger(gid) && home ? { home, uid, gid } : undefined);
    });
  });
}

interface ServiceContext {
  configPath: string;
  cacheDir: string;
  defaultRootfsPath: string;
  uid: number;
  gid: number;
}

/**
 * `sudo brevi worker update` runs as root, but brevi-worker.service runs as the `brevi`
 * service user with its own ~/.brevi (typically /var/lib/brevi/.brevi). Left alone, a root
 * run would read root's own config and cache the rootfs under root's home: a directory the
 * daemon never looks at and the installer's uninstall path never removes. Detects that
 * situation (the unit is installed and we are root) and resolves the service user's paths
 * to act on instead. Returns undefined for the ordinary case, a standalone binary a normal
 * user updates for themselves, which keeps using its own paths exactly as before.
 */
async function resolveServiceContext(): Promise<ServiceContext | undefined> {
  if (!existsSync(SYSTEMD_UNIT_PATH)) return undefined;
  if (process.getuid?.() !== 0) return undefined;

  const identity = await resolveServiceIdentity();
  if (identity === undefined) {
    console.log(
      pc.yellow(
        `! brevi-worker.service is installed, but could not resolve the "${SERVICE_USER}" user via getent; using this process's own paths instead.`,
      ),
    );
    return undefined;
  }

  const breviHome = join(identity.home, ".brevi");
  return {
    configPath: join(breviHome, "config.json"),
    cacheDir: join(breviHome, "cache", "rootfs"),
    defaultRootfsPath: join(breviHome, "images", "rootfs.ext4"),
    uid: identity.uid,
    gid: identity.gid,
  };
}

/** Recursively chowns a path (file or directory tree) to uid:gid. */
async function chownRecursive(path: string, uid: number, gid: number): Promise<void> {
  await chown(path, uid, gid);
  const info = await stat(path);
  if (!info.isDirectory()) return;
  await Promise.all((await readdir(path)).map((entry) => chownRecursive(join(path, entry), uid, gid)));
}

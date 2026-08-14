import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { BREVI_HOME } from "@brevi/shared";
import type { SandboxLaunch } from "../types.js";

/** Host trees bind-mounted read-only so the sandbox can run host binaries. */
const RO_BINDS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

/** Extra host trees that resolv.conf or the dynamic linker often need. */
const OPTIONAL_RO_BINDS = ["/run/systemd/resolve", "/run/resolvconf", "/run/NetworkManager"];

export interface WrapInBwrapOptions {
  /**
   * Call setsid() after unshare. Default true: the right TIOCSTI defense for
   * non-PTY exec. Drop it for PTY attach, where node-pty is already the
   * session leader and setsid() would steal the controlling terminal.
   */
  newSession?: boolean;
  /**
   * Injected via `--clearenv` / `--setenv`. When omitted, a minimal HOME /
   * TMPDIR / PATH is set so the inner process never inherits the host env.
   */
  env?: Record<string, string>;
}

/**
 * Builds the `bwrap` argv that runs `command` inside the sandbox.
 *
 * The workspace root (the per-run directory, not just `workspace/`) is
 * bind-mounted read-write so credential homes and resume scripts that live
 * beside the checkout stay reachable. The operator's $HOME is not bound.
 * `~/.brevi/cache` is not bound as a whole (that would let one run poison
 * host-side npm prefixes); the Playwright browser cache is bound read-only
 * when it already exists.
 */
export function wrapInBwrap(
  bwrap: string,
  workspaceRoot: string,
  command: string,
  args: string[],
  cwd: string,
  options: WrapInBwrapOptions = {},
): SandboxLaunch {
  const env = options.env ?? {
    HOME: workspaceRoot,
    TMPDIR: "/tmp",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };

  const argv: string[] = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--clearenv",
  ];
  if (options.newSession !== false) argv.push("--new-session");
  argv.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/dev/shm", "--chdir", cwd);

  for (const [key, value] of Object.entries(env)) {
    if (key === "") continue;
    argv.push("--setenv", key, value);
  }

  const bound = new Set<string>();
  const roBind = (src: string, dest = src): void => {
    if (bound.has(dest) || !existsSync(src)) return;
    bound.add(dest);
    argv.push("--ro-bind", src, dest);
  };

  for (const dir of RO_BINDS) {
    if (isDir(dir)) roBind(dir);
  }
  for (const dir of OPTIONAL_RO_BINDS) {
    if (isDir(dir)) roBind(dir);
  }
  bindResolvTarget(roBind);
  for (const dir of pathDirsToBind()) {
    if (!isCovered(dir, RO_BINDS)) roBind(dir);
  }
  bindResolvedCommand(command, (src) => {
    if (!isCovered(src, RO_BINDS)) roBind(src);
  });

  const playwrightCache = `${BREVI_HOME}/cache/ms-playwright`;
  if (isDir(playwrightCache)) roBind(playwrightCache);

  argv.push("--bind", workspaceRoot, workspaceRoot);
  argv.push("--", command, ...args);
  return { file: bwrap, args: argv, env };
}

/** PATH entries that are not already covered by RO_BINDS and are not $HOME itself. */
function pathDirsToBind(): string[] {
  const home = process.env.HOME;
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === "/") continue;
    if (home && (dir === home || dir === `${home}/`)) continue;
    if (!isDir(dir)) continue;
    if (isCovered(dir, RO_BINDS) || isCovered(dir, out)) continue;
    out.push(dir);
    // Unix prefix layout: ~/.nvm/.../bin, ~/.local/bin, a bun prefix. The
    // CLI on PATH is usually a shim; its package tree lives in sibling lib/.
    if (basename(dir) === "bin") {
      const lib = join(dirname(dir), "lib");
      if (isDir(lib) && !isCovered(lib, RO_BINDS) && !isCovered(lib, out)) {
        if (!(home && (lib === home || lib === `${home}/`))) out.push(lib);
      }
    }
  }
  return out;
}

function isCovered(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * If /etc/resolv.conf is a symlink (NetworkManager, systemd-resolved,
 * connman), bind the real file and its parent dir so DNS works inside
 * the sandbox. A regular /etc/resolv.conf is already covered by /etc.
 */
function bindResolvTarget(roBind: (src: string) => void): void {
  const resolv = "/etc/resolv.conf";
  try {
    if (!existsSync(resolv)) return;
    const real = realpathSync(resolv);
    if (real === resolv || isCovered(real, RO_BINDS)) return;
    roBind(real);
    const parent = dirname(real);
    if (isDir(parent) && !isCovered(parent, RO_BINDS)) roBind(parent);
  } catch {
    // missing or unreadable: the /etc bind is all we can do
  }
}

/**
 * Bind the resolved command, its realpath, and the npm/nvm package tree it
 * lives in. Binding only the entry file leaves sibling modules invisible, so
 * a user-local Codex/Claude launcher fails inside bwrap.
 */
function bindResolvedCommand(command: string, roBind: (src: string) => void): void {
  const resolved = resolveOnPath(command);
  if (resolved === undefined) return;
  roBind(resolved);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    return;
  }
  if (real !== resolved) roBind(real);
  const nodeModules = nodeModulesRoot(real);
  if (nodeModules !== undefined) roBind(nodeModules);
  const pkgRoot = nearestPackageRoot(real);
  if (pkgRoot !== undefined) roBind(pkgRoot);
}

function nodeModulesRoot(file: string): string | undefined {
  const idx = file.lastIndexOf("/node_modules/");
  if (idx === -1) return undefined;
  return file.slice(0, idx + "/node_modules".length);
}

function nearestPackageRoot(file: string): string | undefined {
  let dir = dirname(file);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolveOnPath(nameOrPath: string): string | undefined {
  if (nameOrPath.includes("/")) return isExecutable(nameOrPath) ? nameOrPath : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, nameOrPath);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

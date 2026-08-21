import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * Resolves an executable the way a shell would: absolute/relative paths are checked
 * directly, bare names are looked up on PATH. Returns undefined when not found.
 */
export async function resolveBinary(nameOrPath: string): Promise<string | undefined> {
  if (nameOrPath.includes("/")) {
    return (await accessible(nameOrPath, constants.X_OK)) ? nameOrPath : undefined;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, nameOrPath);
    if (await accessible(candidate, constants.X_OK)) return candidate;
  }
  return undefined;
}

async function accessible(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

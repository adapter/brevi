import { isAbsolute, resolve } from "node:path";

/** Resolves a caller-supplied host path against the sandbox workspace root. */
export function resolveHostPath(workspacePath: string, path?: string): string {
  if (path === undefined || path === "") return workspacePath;
  return isAbsolute(path) ? path : resolve(workspacePath, path);
}

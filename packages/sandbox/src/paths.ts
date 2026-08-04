import { isAbsolute, resolve } from "node:path";
import { join as posixJoin } from "node:path/posix";

/** Resolves a caller-supplied host path against the sandbox workspace root. */
export function resolveHostPath(workspacePath: string, path?: string): string {
  if (path === undefined || path === "") return workspacePath;
  return isAbsolute(path) ? path : resolve(workspacePath, path);
}

/** Resolves a caller-supplied guest path against the sandbox workspace root. */
export function resolveGuestPath(workspacePath: string, path?: string): string {
  if (path === undefined || path === "") return workspacePath;
  return path.startsWith("/") ? path : posixJoin(workspacePath, path);
}

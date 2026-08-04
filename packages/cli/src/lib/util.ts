import { cancel, isCancel } from "@clack/prompts";

/**
 * Unwraps a @clack/prompts result, exiting the process gracefully (code 0)
 * when the user cancelled the prompt (Ctrl+C / Esc).
 */
export function exitOnCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

/** Extracts a readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True when `err` looks like it timed out or the network was unreachable. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "TypeError" ||
    "cause" in err ||
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(err.message)
  );
}

interface ZodLikeIssue {
  path: Array<string | number>;
  message: string;
}

interface ZodLikeError {
  issues: ZodLikeIssue[];
}

/**
 * Duck-types a zod ParseError without depending on the `zod` package directly
 * (it isn't a direct dependency of this package).
 */
export function isZodLikeError(err: unknown): err is ZodLikeError {
  return (
    typeof err === "object" &&
    err !== null &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  );
}

export function formatZodIssues(err: ZodLikeError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

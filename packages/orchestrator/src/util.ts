/**
 * Small run-pipeline helpers shared across runner.ts and review.ts:
 * cancellation plumbing and a line-buffering sink for streamed exec output.
 */

export class RunCancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelledError";
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunCancelledError();
}

export async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new RunCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // If we lost the race, don't let the abandoned promise become an unhandled rejection.
    promise.catch(() => undefined);
  }
}

/** Buffers chunks and invokes the callback once per complete, non-empty line. */
export function lineSink(onLine: (line: string) => void): { write(chunk: string): void; flush(): void } {
  let buffer = "";
  return {
    write(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    },
  };
}

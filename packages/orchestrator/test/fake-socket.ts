import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { HostMessage, WorkerMessage } from "@brevi/shared";

// Shared by workers.test.ts and enrollment.test.ts; not a test file itself, so
// `bun test` never picks it up on its own.

export const OPEN = 1;
export const CLOSED = 3;

/**
 * Stands in for a worker's end of the socket: collects what the host sent and
 * lets a test push frames back as that worker. Only the surface the registry
 * actually uses is implemented (`on`, `send`, `close`, `terminate`,
 * `readyState`, `OPEN`).
 */
export class FakeSocket extends EventEmitter {
  readonly sent: HostMessage[] = [];
  readyState = OPEN;
  readonly OPEN = OPEN;

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as HostMessage);
  }

  close(): void {
    this.drop();
  }

  terminate(): void {
    this.drop();
  }

  /** The socket going away, from either side. */
  drop(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close");
  }

  /** Deliver one frame from the worker to the host. */
  receive(message: WorkerMessage): void {
    this.emit("message", JSON.stringify(message));
  }

  /** Every frame of one type the host has sent so far. */
  ofType<T extends HostMessage["type"]>(type: T): Extract<HostMessage, { type: T }>[] {
    return this.sent.filter((message) => message.type === type) as Extract<HostMessage, { type: T }>[];
  }

  last<T extends HostMessage["type"]>(type: T): Extract<HostMessage, { type: T }> | undefined {
    return this.ofType(type).at(-1);
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/**
 * Settle the queues the host's awaited writes run on: fleet-state writes on
 * registration, and a lease's chained run-store writes (see
 * WorkerRegistry#chainLeaseWrite), which a completion waits for. One turn is
 * not always enough; draining a few keeps that from showing up as a flaky
 * assertion on whatever the last write settles.
 */
export async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

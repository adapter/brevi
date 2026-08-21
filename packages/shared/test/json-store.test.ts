import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, atomicWriteJson, WriteQueue } from "../src/jsonStore.js";

// Run with `bun test packages/shared`.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "brevi-jsonstore-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WriteQueue", () => {
  it("runs writes strictly in the order they were enqueued", async () => {
    const queue = new WriteQueue();
    const order: number[] = [];
    const slow = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
    });
    const fast = queue.enqueue(async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it("keeps the chain alive after a failed write, and only that write's promise rejects", async () => {
    const queue = new WriteQueue();
    const failed = queue.enqueue(() => Promise.reject(new Error("disk full")));
    await expect(failed).rejects.toThrow("disk full");
    let ran = false;
    await queue.enqueue(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("flush waits for everything queued so far and never rejects over a failed write", async () => {
    const queue = new WriteQueue();
    let done = false;
    void queue.enqueue(() => Promise.reject(new Error("boom"))).catch(() => undefined);
    void queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      done = true;
    }).catch(() => undefined);
    await queue.flush();
    expect(done).toBe(true);
  });
});

describe("atomicWriteFile", () => {
  it("creates missing directories and replaces the file with no temp file left behind", async () => {
    const path = join(dir, "nested", "state.json");
    await atomicWriteFile(path, "one\n");
    await atomicWriteFile(path, "two\n");
    expect(await readFile(path, "utf8")).toBe("two\n");
    expect(await readdir(join(dir, "nested"))).toEqual(["state.json"]);
  });

  it("applies the requested mode to the destination", async () => {
    const path = join(dir, "secrets.json");
    await atomicWriteFile(path, "{}\n", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("cleans up its temp file when the write fails", async () => {
    // The destination's parent is a plain file, so the rename must fail.
    await atomicWriteFile(join(dir, "blocker"), "x");
    await expect(atomicWriteFile(join(dir, "blocker", "state.json"), "y")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["blocker"]);
  });
});

describe("atomicWriteJson", () => {
  it("writes pretty-printed JSON with a trailing newline", async () => {
    const path = join(dir, "value.json");
    await atomicWriteJson(path, { a: 1 });
    expect(await readFile(path, "utf8")).toBe('{\n  "a": 1\n}\n');
  });
});

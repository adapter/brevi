import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerCapabilities } from "@brevi/shared";
import { FleetStore } from "../src/fleet.js";

// Run with `bun test packages/orchestrator` from the repo root (after
// `bun run build`, so the @brevi/shared import resolves to its dist output).
// Not part of the tsc build: the package's tsconfig only includes src/.

const capabilities: WorkerCapabilities = {
  os: "linux",
  arch: "x64",
  provider: "process",
  kvm: false,
  maxConcurrency: 1,
  vmSizes: [],
  version: "0.1.0",
};

let dir: string;
let fleetPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "brevi-fleet-"));
  fleetPath = join(dir, "fleet.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FleetStore pairing", () => {
  it("redeems a pairing token exactly once", async () => {
    const store = new FleetStore(fleetPath);
    const { token } = store.mintPairingToken();

    const first = await store.redeemPairing(token, { name: "bench-1", capabilities });
    if ("error" in first) throw new Error("expected the first redeem to succeed");
    expect(first.worker.name).toBe("bench-1");

    const second = await store.redeemPairing(token, { name: "bench-1", capabilities });
    expect(second).toEqual({ error: "invalid-token" });
  });

  it("refuses a token past its expiry", async () => {
    // A negative TTL mints a token whose expiresAt is already in the past,
    // without needing to wait or fake the clock.
    const store = new FleetStore(fleetPath, -1);
    const { token } = store.mintPairingToken();

    const result = await store.redeemPairing(token, { name: "bench-1", capabilities });
    expect(result).toEqual({ error: "expired-token" });

    // Also single-use once looked at, even though it never redeemed: a retry
    // must not somehow succeed just because the first attempt failed.
    const retry = await store.redeemPairing(token, { name: "bench-1", capabilities });
    expect(retry).toEqual({ error: "invalid-token" });
  });

  it("sets lastSeenAt on redeem: the redeem is itself a successful connect", async () => {
    const store = new FleetStore(fleetPath);
    const { token } = store.mintPairingToken();

    const result = await store.redeemPairing(token, { name: "bench-1", capabilities });
    if ("error" in result) throw new Error("expected redeem to succeed");

    // Otherwise a dashboard open right after enrollment would read "never
    // connected" for a worker that is, at that moment, live.
    expect(result.worker.lastSeenAt).toBe(result.worker.enrolledAt);
  });
});

describe("FleetStore credentials", () => {
  it("authenticates only the credential redeemPairing returned", async () => {
    const store = new FleetStore(fleetPath);
    const { token } = store.mintPairingToken();
    const result = await store.redeemPairing(token, { name: "bench-1", capabilities });
    if ("error" in result) throw new Error("expected redeem to succeed");
    const { worker, credential } = result;

    expect(store.authenticate(worker.id, credential)?.id).toBe(worker.id);
    expect(store.authenticate(worker.id, "wrong-secret")).toBeNull();
    expect(store.authenticate("wk-doesnotexist", credential)).toBeNull();
  });

  it("kills the credential on revoke", async () => {
    const store = new FleetStore(fleetPath);
    const { token } = store.mintPairingToken();
    const result = await store.redeemPairing(token, { name: "bench-1", capabilities });
    if ("error" in result) throw new Error("expected redeem to succeed");
    const { worker, credential } = result;

    expect(await store.revoke(worker.id)).toBe(true);
    expect(store.authenticate(worker.id, credential)).toBeNull();
    // A second revoke finds nothing left to remove.
    expect(await store.revoke(worker.id)).toBe(false);
  });

  it("keeps the credential live when a revoke's write fails, and a retried revoke succeeds once writes work again", async () => {
    // fleet.json lives under <dir>/blocked; as long as `blocked` is a real
    // directory, writes land normally. Swapping it for a plain file makes
    // mkdir(dirname(path), { recursive: true }) inside #persist reject
    // (EEXIST), without depending on file permission bits: this suite may
    // run as root, where a chmod'd-away directory would still be writable.
    const blockedDir = join(dir, "blocked");
    const store = new FleetStore(join(blockedDir, "fleet.json"));
    const { token } = store.mintPairingToken();
    const result = await store.redeemPairing(token, { name: "bench-1", capabilities });
    if ("error" in result) throw new Error("expected redeem to succeed");
    const { worker, credential } = result;

    await rm(blockedDir, { recursive: true, force: true });
    await writeFile(blockedDir, "");

    await expect(store.revoke(worker.id)).rejects.toThrow();
    // The failed write must not have dropped the in-memory record: the
    // credential stays live, consistent with what's still on disk, until the
    // deletion actually lands.
    expect(store.authenticate(worker.id, credential)?.id).toBe(worker.id);

    // Unblock writes and retry: the same revoke call now goes through.
    await rm(blockedDir, { force: true });
    expect(await store.revoke(worker.id)).toBe(true);
    expect(store.authenticate(worker.id, credential)).toBeNull();
  });
});

describe("FleetStore ordering", () => {
  it("list() stays sorted oldest enrollment first across a removal, an addition, and a restore", async () => {
    // Nested under a directory that gets swapped for a blocking file partway
    // through, the same trick as the revoke-persist-failure test above, to
    // exercise the restore case without a second store.
    const blockedDir = join(dir, "blocked");
    const store = new FleetStore(join(blockedDir, "fleet.json"));

    const enroll = async (name: string) => {
      const { token } = store.mintPairingToken();
      const result = await store.redeemPairing(token, { name, capabilities });
      if ("error" in result) throw new Error("expected redeem to succeed");
      return result.worker;
    };
    // enrolledAt has millisecond resolution; a beat between enrollments keeps
    // them distinguishable instead of racing to a tie.
    const beat = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

    const first = await enroll("first");
    await beat();
    const second = await enroll("second");
    await beat();
    const third = await enroll("third");
    expect(store.list().map((w) => w.id)).toEqual([first.id, second.id, third.id]);

    // Remove the middle enrollment and add a new one after: insertion order
    // alone would put the newcomer last too, which happens to also be
    // enrollment order here, so this step alone doesn't prove sorting, the
    // restore below does.
    expect(await store.revoke(second.id)).toBe(true);
    await beat();
    const fourth = await enroll("fourth");
    expect(store.list().map((w) => w.id)).toEqual([first.id, third.id, fourth.id]);

    // Fail to revoke the oldest survivor. FleetStore.revoke restores it with
    // a fresh Map.set, which lands at the end of insertion order; list()
    // must still report it first because it sorts by enrolledAt.
    await rm(blockedDir, { recursive: true, force: true });
    await writeFile(blockedDir, "");
    await expect(store.revoke(first.id)).rejects.toThrow();
    await rm(blockedDir, { force: true });

    expect(store.list().map((w) => w.id)).toEqual([first.id, third.id, fourth.id]);
  });
});

describe("FleetStore persistence", () => {
  it("survives a restart with rename and drain applied", async () => {
    const store = new FleetStore(fleetPath);
    const { token } = store.mintPairingToken();
    const result = await store.redeemPairing(token, { name: "bench-1", capabilities });
    if ("error" in result) throw new Error("expected redeem to succeed");
    const { worker } = result;

    await store.rename(worker.id, "renamed-bench");
    await store.setState(worker.id, "draining");

    const restarted = new FleetStore(fleetPath);
    await restarted.init();
    const revived = restarted.get(worker.id);
    expect(revived?.name).toBe("renamed-bench");
    expect(revived?.state).toBe("draining");
    expect(revived?.enrolledAt).toBe(worker.enrolledAt);
  });

  it("never writes the plaintext credential to disk", async () => {
    const store = new FleetStore(fleetPath);
    const { token } = store.mintPairingToken();
    const result = await store.redeemPairing(token, { name: "bench-1", capabilities });
    if ("error" in result) throw new Error("expected redeem to succeed");
    const { credential } = result;

    const bytes = await readFile(fleetPath, "utf8");
    expect(bytes.includes(credential)).toBe(false);
    // The pairing token itself must not appear either.
    expect(bytes.includes(token)).toBe(false);
  });
});

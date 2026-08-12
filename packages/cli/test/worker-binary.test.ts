import { afterEach, describe, expect, it } from "bun:test";
import { fetchWorkerBinaryManifest, WORKER_BINARY_BASE_URL } from "../src/lib/worker-binary.js";

// Run with `bun test packages/cli` from the repo root. The manifest is the only
// thing standing between `brevi worker update` and writing an arbitrary binary
// over the running executable, so what it accepts is worth pinning down: a
// manifest that is internally consistent but describes a different release or a
// different architecture must be refused before anything is downloaded, since
// every checksum after that point would happily verify the wrong artifact.

const realFetch = globalThis.fetch;

function manifestFor(cliVersion: string, arch: string): Record<string, unknown> {
  return {
    cliVersion,
    arch,
    binary: { name: `brevi-${arch}`, sha256: "a".repeat(64), sizeBytes: 100 },
    compressed: { name: `brevi-${arch}.gz`, sha256: "b".repeat(64), sizeBytes: 40 },
  };
}

/** Answers every request with `body` at `status`, and records the URLs asked for. */
function stubFetch(body: unknown, status = 200): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof globalThis.fetch;
  return urls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchWorkerBinaryManifest", () => {
  it("returns the manifest when it names the requested release and architecture", async () => {
    const urls = stubFetch(manifestFor("1.2.3", "x86_64"));

    const manifest = await fetchWorkerBinaryManifest("1.2.3", "x86_64");

    expect(manifest.cliVersion).toBe("1.2.3");
    expect(manifest.arch).toBe("x86_64");
    expect(manifest.compressed.name).toBe("brevi-x86_64.gz");
    expect(urls).toEqual([`${WORKER_BINARY_BASE_URL}/1.2.3/x86_64/manifest.json`]);
  });

  it("refuses a manifest published for another release", async () => {
    stubFetch(manifestFor("1.2.2", "x86_64"));

    await expect(fetchWorkerBinaryManifest("1.2.3", "x86_64")).rejects.toThrow(
      /is for @brevi\/cli 1\.2\.2, expected 1\.2\.3/,
    );
  });

  it("refuses a manifest published for another architecture", async () => {
    stubFetch(manifestFor("1.2.3", "aarch64"));

    await expect(fetchWorkerBinaryManifest("1.2.3", "x86_64")).rejects.toThrow(/is for aarch64, expected x86_64/);
  });

  it("refuses a manifest missing the fields the download depends on", async () => {
    stubFetch({ cliVersion: "1.2.3", arch: "x86_64", binary: { name: "brevi-x86_64" } });

    await expect(fetchWorkerBinaryManifest("1.2.3", "x86_64")).rejects.toThrow(/unexpected shape/);
  });

  it("says which release and architecture is missing on a 404, not just the status", async () => {
    stubFetch({}, 404);

    await expect(fetchWorkerBinaryManifest("9.9.9", "aarch64")).rejects.toThrow(
      /no worker binary is published for @brevi\/cli 9\.9\.9 \(aarch64\)/,
    );
  });

  it("refuses a base url that is not on the download allowlist", async () => {
    stubFetch(manifestFor("1.2.3", "x86_64"));

    await expect(fetchWorkerBinaryManifest("1.2.3", "x86_64", "https://example.com/worker")).rejects.toThrow(
      /disallowed host/,
    );
  });
});

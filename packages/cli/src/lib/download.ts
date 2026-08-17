import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

/**
 * Exact hosts allowed for setup artifact downloads. images.brevi.dev serves
 * the worker binaries published per @brevi/cli release.
 */
const ALLOWED_HOSTS = new Set(["github.com", "s3.amazonaws.com", "images.brevi.dev"]);

/**
 * Hosts ending in these suffixes are allowed too. GitHub serves release
 * assets from hosts like objects.githubusercontent.com and
 * release-assets.githubusercontent.com via redirect.
 */
const ALLOWED_HOST_SUFFIXES = [".githubusercontent.com"];

/**
 * Validates that `url` is an https URL pointing at a host on the setup
 * download allowlist, throwing otherwise. Returns the parsed URL so callers
 * can reuse it (e.g. to resolve a redirect's Location header against it).
 */
export function assertAllowedDownloadUrl(url: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Could not parse download URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to download ${parsed}: only https downloads are allowed.`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    ALLOWED_HOSTS.has(host) || ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    throw new Error(`Refusing to download from disallowed host "${host}": ${parsed}`);
  }
  return parsed;
}

/**
 * Streams a URL to disk via a .partial file, so an aborted download never looks
 * complete, and verifies the sha256 digest before the file lands at its final name.
 * Downloads are restricted to an https host allowlist, with each redirect hop
 * revalidated against it, to guard against SSRF.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  sha256: string,
  onProgress?: (bytes: number) => void,
): Promise<void> {
  let current = assertAllowedDownloadUrl(url);
  let res = await fetch(current, { redirect: "manual" });
  for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers.get("location");
    if (location === null) break;
    await res.body?.cancel();
    if (hop >= 5) {
      throw new Error(`Too many redirects while downloading ${url}`);
    }
    current = assertAllowedDownloadUrl(new URL(location, current));
    res = await fetch(current, { redirect: "manual" });
  }

  if (!res.ok || res.body === null) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  const body = res.body;

  const partial = `${dest}.partial`;
  const hash = createHash("sha256");
  try {
    let bytes = 0;
    await pipeline(async function* () {
      for await (const chunk of body) {
        bytes += chunk.length;
        hash.update(chunk);
        onProgress?.(bytes);
        yield chunk;
      }
    }, createWriteStream(partial));
    const actual = hash.digest("hex");
    if (actual !== sha256) {
      throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
    }
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, dest);
}

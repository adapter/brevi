import { execa } from "execa";
import type { ArtifactRef, BreviConfig } from "@brevi/shared";
import { resolveWithin } from "./safepath.js";

/**
 * Cloudflare R2 evidence uploads: pushes a run's demo screenshots/recordings
 * to a public R2 bucket and hands back their public URLs so `runner.ts` can
 * embed them in the PR description. There is no stored credential for this;
 * authentication rides on the host's own `wrangler` CLI login (`wrangler
 * whoami` / `wrangler login` / `wrangler r2 object put`), the same way
 * `connect.ts` reuses the `gh` CLI's login instead of asking for a GitHub
 * token twice.
 *
 * Everything here is best-effort. A run's PR must still open even if
 * wrangler is missing, the user never logged in, or a single upload fails
 * partway through, so every function that touches wrangler or ffmpeg
 * swallows its own errors and degrades: uploads are skipped, individual
 * files are dropped, and callers always get a (possibly empty) result
 * rather than a rejected promise.
 *
 * Videos get an extra step before upload: a short animated GIF rendered
 * with ffmpeg. GitHub strips `<video>`/`<source>` tags from PR markdown, so
 * a plain video link renders as inert text, but an external GIF still
 * renders inline (proxied through GitHub's camo), giving the PR a clickable
 * animated thumbnail that opens the full recording. When ffmpeg isn't
 * available or fails, the video still uploads; the PR just carries a plain
 * link instead of a thumbnail.
 */

export interface WranglerAuth {
  installed: boolean;
  loggedIn: boolean;
  account?: string;
  /** The probe hit its deadline, so loggedIn is unknown rather than false. */
  timedOut?: boolean;
}

const LOGGED_IN_RE = /You are logged in/i;
const ACCOUNT_RE = /associated with the email\s+(\S+?)\.?(?:\s|$)/i;

/** Probe the host's wrangler CLI: is it installed, and is it authenticated. */
export async function checkWrangler(timeoutMs = 20_000): Promise<WranglerAuth> {
  let result: { stdout: string; stderr: string; code?: string; timedOut?: boolean };
  try {
    result = await execa("wrangler", ["whoami"], { timeout: timeoutMs, reject: false });
  } catch {
    return { installed: false, loggedIn: false };
  }
  if (result.timedOut) return { installed: true, loggedIn: false, timedOut: true };
  // With reject: false a failed spawn resolves too; ENOENT means not on PATH.
  if (result.code === "ENOENT") return { installed: false, loggedIn: false };
  const output = `${result.stdout}\n${result.stderr}`;
  if (!LOGGED_IN_RE.test(output)) return { installed: true, loggedIn: false };
  const account = ACCOUNT_RE.exec(output)?.[1];
  return { installed: true, loggedIn: true, account };
}

/**
 * Start `wrangler login` on the host; wrangler opens the browser itself.
 * Never throws: the caller only cares that it was started, and polls
 * `checkWrangler` afterward to see whether it succeeded.
 */
export function startWranglerLogin(): Promise<unknown> {
  return execa("wrangler", ["login"], { timeout: 5 * 60_000, reject: false });
}

/** Deterministic default bucket name used by one-click provisioning. */
export const DEFAULT_EVIDENCE_BUCKET = "brevi-evidence";

export type ProvisionResult =
  | { ok: true; bucket: string; publicBaseUrl: string }
  | { ok: false; reason: string };

const PUBLIC_URL_RE = /https:\/\/pub-[0-9a-z]+\.r2\.dev/i;

/** First non-empty line of stderr, else stdout, else a generic exit-code message. */
function firstErrorLine(result: { stdout: string; stderr: string; exitCode?: number }): string {
  const stderrLine = result.stderr.split("\n").find((line) => line.trim());
  if (stderrLine) return stderrLine;
  const stdoutLine = result.stdout.split("\n").find((line) => line.trim());
  if (stdoutLine) return stdoutLine;
  return `exit code ${result.exitCode}`;
}

/**
 * Read-only probe that the configured evidence bucket exists and answers,
 * for diagnostics: asks wrangler for the bucket's dev URL without
 * creating or changing anything.
 */
export async function checkBucketAccessible(
  bucket: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; detail: string; timedOut?: boolean }> {
  let result: { stdout: string; stderr: string; exitCode?: number; code?: string; timedOut?: boolean };
  try {
    result = await execa("wrangler", ["r2", "bucket", "dev-url", "get", bucket], {
      timeout: timeoutMs,
      reject: false,
    });
  } catch {
    return { ok: false, detail: "the wrangler CLI is not installed" };
  }
  if (result.timedOut) {
    return { ok: false, timedOut: true, detail: `wrangler did not answer within ${timeoutMs / 1000}s` };
  }
  if (result.code === "ENOENT") {
    return { ok: false, detail: "the wrangler CLI is not installed" };
  }
  if (result.exitCode !== 0) {
    return { ok: false, detail: firstErrorLine(result) };
  }
  const url = PUBLIC_URL_RE.exec(`${result.stdout}\n${result.stderr}`)?.[0];
  return {
    ok: true,
    detail: url ? `bucket "${bucket}" answered (${url})` : `bucket "${bucket}" answered`,
  };
}

/**
 * One-click bucket provisioning for the R2 evidence connector: creates the
 * bucket and enables its r2.dev public URL, returning the URL to persist to
 * config. A bucket that already exists is reused only when its dev URL is
 * already enabled; public access is never turned on for a bucket this call
 * did not create, so pre-existing private contents cannot be exposed by a
 * click. Assumes the caller already confirmed wrangler is installed and
 * logged in; never throws, degrading to a failure reason instead so the
 * dashboard can surface it.
 */
export async function provisionBucket(bucket: string = DEFAULT_EVIDENCE_BUCKET): Promise<ProvisionResult> {
  let createResult: { stdout: string; stderr: string; exitCode?: number; code?: string };
  try {
    createResult = await execa("wrangler", ["r2", "bucket", "create", bucket], { timeout: 60_000, reject: false });
  } catch {
    return { ok: false, reason: "The wrangler CLI is not installed on this machine." };
  }
  if (createResult.code === "ENOENT") {
    return { ok: false, reason: "The wrangler CLI is not installed on this machine." };
  }
  if (createResult.exitCode !== 0) {
    const output = `${createResult.stdout}\n${createResult.stderr}`;
    if (!/already exists/i.test(output)) {
      return { ok: false, reason: `Could not create bucket "${bucket}": ${firstErrorLine(createResult)}` };
    }
    // The bucket already exists. Public access is only ever enabled on a
    // bucket this function just created: a pre-existing one may predate
    // brevi and hold objects the user never meant to publish, so its dev
    // URL is read back and reused only if it is already public (a previous
    // a previous installation); otherwise provisioning fails with instructions instead
    // of silently exposing it.
    const getResult = await execa("wrangler", ["r2", "bucket", "dev-url", "get", bucket], {
      timeout: 60_000,
      reject: false,
    });
    const existingUrl = PUBLIC_URL_RE.exec(`${getResult.stdout}\n${getResult.stderr}`)?.[0];
    if (existingUrl) return { ok: true, bucket, publicBaseUrl: existingUrl };
    return {
      ok: false,
      reason:
        `Bucket "${bucket}" already exists but is not public, and brevi will not expose an existing bucket's contents. ` +
        `If publishing it is safe, run wrangler r2 bucket dev-url enable ${bucket} and connect again, or enter a different bucket manually.`,
    };
  }

  const enableResult = await execa("wrangler", ["r2", "bucket", "dev-url", "enable", bucket, "-y"], {
    timeout: 60_000,
    reject: false,
  });
  const enableOutput = `${enableResult.stdout}\n${enableResult.stderr}`;
  const enabledUrl = PUBLIC_URL_RE.exec(enableOutput)?.[0];
  if (enabledUrl) return { ok: true, bucket, publicBaseUrl: enabledUrl };

  if (enableResult.exitCode !== 0) {
    return { ok: false, reason: firstErrorLine(enableResult) };
  }
  return { ok: false, reason: "Could not read the bucket's r2.dev public URL from wrangler output." };
}

export interface UploadedEvidence {
  name: string;
  kind: "image" | "video";
  /** Public URL of the asset. */
  url: string;
  /** Public URL of the animated GIF preview, present for videos when generation succeeded. */
  previewUrl?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function extOf(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

interface EvidenceCandidate {
  name: string;
  kind: "image" | "video";
}

/**
 * Which collected artifacts are worth putting in a PR: screenshots and GIFs
 * embed directly as images, other recordings are videos; documents and logs
 * are not evidence and are left alone.
 */
function selectEvidence(artifacts: ArtifactRef[]): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const artifact of artifacts) {
    const ext = extOf(artifact.name);
    if (artifact.type === "screenshot") {
      candidates.push({ name: artifact.name, kind: "image" });
    } else if (artifact.type === "recording") {
      if (ext === "gif") candidates.push({ name: artifact.name, kind: "image" });
      else if (ext === "webm" || ext === "mp4" || ext === "mov") {
        candidates.push({ name: artifact.name, kind: "video" });
      }
    }
  }
  return candidates;
}

function publicUrl(publicBaseUrl: string, runId: string, name: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/${runId}/${encodeURIComponent(name)}`;
}

/**
 * Upload one file to the bucket at `<bucket>/<runId>/<name>`; returns
 * whether it succeeded, logging the failure reason otherwise.
 */
async function uploadFile(options: {
  bucket: string;
  runId: string;
  name: string;
  filePath: string;
  contentType: string;
  log: (text: string) => void;
}): Promise<boolean> {
  const { bucket, runId, name, filePath, contentType, log } = options;
  const key = `${bucket}/${runId}/${name}`;
  const result = await execa(
    "wrangler",
    ["r2", "object", "put", key, "--file", filePath, "--content-type", contentType, "--remote"],
    { timeout: 180_000, reject: false },
  );
  if (result.exitCode !== 0) {
    const firstErrorLine = result.stderr.split("\n").find((line) => line.trim());
    log(`R2 upload failed for ${name}: ${firstErrorLine ?? `exit code ${result.exitCode}`}`);
    return false;
  }
  return true;
}

/**
 * Best-effort short animated GIF preview of a video, for the "Loom
 * treatment": a clickable thumbnail in the PR instead of a dead link.
 * Returns the generated file's path, or undefined if ffmpeg is missing,
 * fails, or produces nothing.
 */
async function generateGifPreview(options: {
  name: string;
  videoPath: string;
  gifPath: string;
  log: (text: string) => void;
}): Promise<string | undefined> {
  const { name, videoPath, gifPath, log } = options;
  try {
    const result = await execa(
      "ffmpeg",
      ["-y", "-t", "4", "-i", videoPath, "-vf", "fps=8,scale=480:-1:flags=lanczos", "-loop", "0", gifPath],
      { timeout: 60_000, reject: false },
    );
    if (result.exitCode !== 0) {
      const firstErrorLine = result.stderr.split("\n").find((line) => line.trim());
      log(`GIF preview failed for ${name}: ${firstErrorLine ?? `exit code ${result.exitCode}`}; the PR will carry a plain link`);
      return undefined;
    }
  } catch (error) {
    log(
      `GIF preview failed for ${name}: ${error instanceof Error ? error.message : String(error)}; the PR will carry a plain link`,
    );
    return undefined;
  }
  return gifPath;
}

export async function uploadRunEvidence(options: {
  runId: string;
  /** Directory the collected artifact files live in. */
  artifactsDir: string;
  artifacts: ArtifactRef[];
  config: BreviConfig;
  log: (text: string) => void;
}): Promise<UploadedEvidence[]> {
  const { runId, artifactsDir, artifacts, config, log } = options;
  const { bucket, publicBaseUrl } = config.r2;
  if (!bucket || !publicBaseUrl) return [];

  const auth = await checkWrangler();
  if (!auth.installed) {
    log("R2 evidence upload skipped: wrangler is not installed");
    return [];
  }
  if (!auth.loggedIn) {
    log("R2 evidence upload skipped: wrangler is not logged in (run wrangler login)");
    return [];
  }

  const uploaded: UploadedEvidence[] = [];
  for (const candidate of selectEvidence(artifacts)) {
    const { name, kind } = candidate;
    // Artifact names are persisted from agent output; a hostile name must
    // not make wrangler read (and publicly upload) a file outside the run's
    // artifact directory.
    const filePath = resolveWithin(artifactsDir, name);
    if (!filePath) {
      log(`R2 evidence upload skipped for ${name}: unsafe file name`);
      continue;
    }
    const contentType = CONTENT_TYPES[extOf(name)];
    if (!contentType) continue;

    if (kind === "image") {
      const ok = await uploadFile({ bucket, runId, name, filePath, contentType, log });
      if (ok) uploaded.push({ name, kind, url: publicUrl(publicBaseUrl, runId, name) });
      continue;
    }

    // Video: try the GIF preview first, upload it if it renders, then the video itself.
    let previewUrl: string | undefined;
    const gifPath = `${filePath}.gif`;
    const generated = await generateGifPreview({ name, videoPath: filePath, gifPath, log });
    if (generated) {
      const gifName = `${name}.gif`;
      const ok = await uploadFile({
        bucket,
        runId,
        name: gifName,
        filePath: generated,
        contentType: "image/gif",
        log,
      });
      if (ok) previewUrl = publicUrl(publicBaseUrl, runId, gifName);
    }

    const ok = await uploadFile({ bucket, runId, name, filePath, contentType, log });
    if (ok) uploaded.push({ name, kind, url: publicUrl(publicBaseUrl, runId, name), previewUrl });
  }

  if (uploaded.length > 0) {
    log(`uploaded ${uploaded.length} evidence file(s) to R2 bucket ${bucket}`);
  }
  return uploaded;
}

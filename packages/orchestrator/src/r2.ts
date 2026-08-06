import { join } from "node:path";
import { execa } from "execa";
import type { ArtifactRef, BreviConfig } from "@brevi/shared";

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
}

const LOGGED_IN_RE = /You are logged in/i;
const ACCOUNT_RE = /associated with the email\s+(\S+?)\.?(?:\s|$)/i;

/** Probe the host's wrangler CLI: is it installed, and is it authenticated. */
export async function checkWrangler(): Promise<WranglerAuth> {
  let result: { stdout: string; stderr: string; code?: string };
  try {
    result = await execa("wrangler", ["whoami"], { timeout: 20_000, reject: false });
  } catch {
    return { installed: false, loggedIn: false };
  }
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
    const filePath = join(artifactsDir, name);
    const contentType = CONTENT_TYPES[extOf(name)];
    if (!contentType) continue;

    if (kind === "image") {
      const ok = await uploadFile({ bucket, runId, name, filePath, contentType, log });
      if (ok) uploaded.push({ name, kind, url: publicUrl(publicBaseUrl, runId, name) });
      continue;
    }

    // Video: try the GIF preview first, upload it if it renders, then the video itself.
    let previewUrl: string | undefined;
    const gifPath = join(artifactsDir, `${name}.gif`);
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

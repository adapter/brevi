import { Notification } from "electron";
import type { Run } from "@brevi/shared";

/** Long enough to be useful, short enough not to blow past the OS's own notification truncation. */
const MAX_ERROR_LENGTH = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

/** Native notification for a finished run; clicking it opens that run's page in the window. */
export function notifyRunFinished(run: Run, open: (path: string) => void): void {
  if (!Notification.isSupported()) return;
  // Cancellation is a user action, not news; nothing to surface for it.
  if (run.status !== "completed" && run.status !== "failed") return;

  const title = run.status === "completed" ? `${run.ticket.identifier} completed` : `${run.ticket.identifier} failed`;
  const body =
    run.status === "completed"
      ? (run.prUrl ?? run.ticket.title)
      : (run.error && truncate(run.error, MAX_ERROR_LENGTH)) || run.ticket.title;

  const notification = new Notification({ title, body });
  notification.on("click", () => open(`/runs/${encodeURIComponent(run.id)}`));
  notification.show();
}

/** Native notification that a downloaded update will apply itself once no runs are in flight; clicking it opens the window. */
export function notifyUpdateReady(version: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title: "brevi",
    body: `Version ${version} is ready. brevi will restart to apply it once no runs are in flight.`,
  });
  notification.on("click", () => onClick());
  notification.show();
}

/** Native notification that an update install didn't take; the app rolled back to the previous version on its own. */
export function notifyUpdateFailed(version: string): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title: "brevi",
    body: `Could not install version ${version}. brevi is still running the previous version.`,
  });
  notification.show();
}

import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

export const DASHBOARD_ORIGIN = "brevi://app";

/** Must be called before app.ready so Chromium treats brevi:// as a normal secure origin. */
export function registerDashboardScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "brevi",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

/** Serves only the packaged renderer; unknown routes fall back to the SPA entry. */
export function registerDashboardProtocol(appDist: string): void {
  const root = resolve(appDist);
  protocol.handle("brevi", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("not found", { status: 404 });

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("not found", { status: 404 });
    }

    const requested = resolve(root, `.${pathname}`);
    const candidate = requested.startsWith(root + sep) && extname(requested) ? requested : resolve(root, "index.html");
    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error("not a file");
      return net.fetch(pathToFileURL(candidate).toString());
    } catch {
      return net.fetch(pathToFileURL(resolve(root, "index.html")).toString());
    }
  });
}

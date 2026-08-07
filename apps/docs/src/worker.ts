/**
 * Docs worker entry: serves the static Astro build via the assets binding
 * and reverse-proxies PostHog under /ingest/* so analytics requests are
 * first-party (see PostHog's Cloudflare proxy guidance). Only /ingest/* is
 * routed here first (assets.run_worker_first in wrangler.jsonc); everything
 * else falls through to the assets handler unchanged.
 */

const API_HOST = 'us.i.posthog.com';
const ASSET_HOST = 'us-assets.i.posthog.com';

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ingest' || url.pathname.startsWith('/ingest/')) {
			const path = url.pathname.slice('/ingest'.length) || '/';
			const host = path.startsWith('/static/') ? ASSET_HOST : API_HOST;
			const headers = new Headers(request.headers);
			headers.set('Host', host);
			return fetch(`https://${host}${path}${url.search}`, {
				method: request.method,
				headers,
				body: request.body,
				redirect: 'follow',
			});
		}
		return env.ASSETS.fetch(request);
	},
};

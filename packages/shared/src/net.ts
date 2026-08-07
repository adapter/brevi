/**
 * Host to dial in a URL for a configured bind address: wildcard and loopback
 * binds map to localhost, and bare IPv6 literals get their URL brackets.
 */
export function urlHost(host: string): string {
  if (["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "::1"].includes(host) || host.startsWith("127.")) {
    return "localhost";
  }
  return host.includes(":") ? `[${host}]` : host;
}

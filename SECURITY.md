# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/adapter/brevi/security/advisories/new)
("Report a vulnerability" on the repository's Security tab). Do not open a
public issue for security reports.

We will acknowledge reports as quickly as we can, usually within a few days,
and keep you informed as a fix progresses.

## Scope

Things we especially care about:

- The hosted OAuth backend (`apps/api`, api.brevi.dev): token handling for
  the Linear and GitHub connect flows.
- Credential handling in the CLI/orchestrator: everything is stored locally
  in `~/.brevi/config.json` and must never leave the machine except to the
  provider it authenticates to.
- Sandbox isolation (`packages/sandbox`): escapes from the Firecracker or
  process sandbox into the host.

Note that the dashboard and its API have no authentication. They bind
`127.0.0.1` by default, so only the machine itself can reach them; setting
`server.host` to a non-loopback address exposes full control of brevi
(credential writes and interactive shells into sandboxes included) to
anything that can reach the port. Only do this on networks you trust.

## Supported versions

Only the latest published release of the `@brevi/*` packages receives
security fixes.

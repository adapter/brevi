# @brevi/worker

The dedicated `brevi-worker` daemon dials Mission Control's authenticated worker channel and executes dispatched runs in Linux bubblewrap sandboxes.

Mission Control installs and updates workers over SSH with `scripts/install.sh`. The installer creates a restricted `brevi` system user, installs the signed/checksummed standalone worker binary, bubblewrap, and supported agent tools, then manages the daemon with `brevi-worker.service`.

Build a native worker binary with:

```sh
bun run build:binary
```

The binary accepts `--host`, `--name`, and `--concurrency`. Enrollment normally comes from Mission Control; the single-use token is passed through a protected file or `BREVI_TOKEN`, not argv.

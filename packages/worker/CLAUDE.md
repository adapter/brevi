# brevi-worker

Dedicated Linux execution daemon. `src/bin.ts` is the standalone entry and `scripts/build-binary.ts` embeds the platform node-pty addon. `scripts/install.sh` installs the binary and systemd service.

Enrollment tokens must come from a protected file or environment, never steady-state argv. The worker dials out and never exposes a listener.

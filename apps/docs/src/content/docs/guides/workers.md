---
title: Workers
description: Provision and operate remote Linux execution workers from Mission Control over SSH.
---

Mission Control schedules work; Linux workers execute it. Workers dial the authenticated worker channel outbound, so they do not need an inbound service port.

## Prepare the host

The remote machine needs:

- Linux on x86_64 or aarch64.
- systemd and OpenSSH.
- Network access to Mission Control's configured worker-channel address.
- An SSH account using the system agent or a selected private key.
- Passwordless `sudo` for unattended installation.

In Configuration → Workers, set the worker channel's bind address and port to an address the remote host can reach, then restart the orchestrator from the menu bar.

## Provision over SSH

Enter the SSH hostname or IP, user, port, optional private-key path, worker name, and concurrency. Mission Control then:

1. Lets OpenSSH verify the host key, saving a newly accepted key in the normal known-hosts file.
2. Checks passwordless sudo.
3. Transfers a single-use pairing token through stdin to a mode-0600 temporary file.
4. Runs the hosted installer with the token file, never with the token in argv.
5. Installs the checksummed `brevi-worker` binary, bubblewrap, supported agent tools, and `brevi-worker.service`.
6. Removes the temporary token and waits for the worker to register.

SSH private keys are read by the system `ssh` process. Pairing credentials remain in Electron's main process and are never returned to the renderer or written to config.

## Operations

Workers can be renamed, drained, re-enabled, or revoked from the Workers page. Draining lets in-flight work finish while preventing new dispatches. Revoking removes the worker's durable credential.

Run SSH setup again to update a worker. The installer is idempotent and preserves `~/.brevi/worker.json`, so enrollment survives upgrades.

To remove a worker, revoke it in Mission Control and run the hosted installer with `--uninstall` over an administrative SSH session.

## Installed files

- `/usr/local/bin/brevi-worker`
- `/usr/local/lib/brevi/worker-start.sh`
- `/etc/brevi/worker.env`
- `/etc/systemd/system/brevi-worker.service`
- `/var/lib/brevi/.brevi/worker.json`

The service user owns its state and workspace. The pairing token is removed after the durable worker credential has been redeemed.

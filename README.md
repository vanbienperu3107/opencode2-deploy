# OpenCode v2 deployment baseline

This public repository contains a secret-free baseline for the isolated
OpenCode v2 deployment. It contains the secret-free Task 1 baseline and the
Task 3 tooling for a dedicated Tailnet SSH identity. It does not contain runtime
secrets, a deployment workflow, edge routing, or the Tailscale sidecar.

## Prerequisites

- Docker Engine with the Compose plugin.
- Access to the GitHub repository's secret store for runtime values.
- Operator-approved infrastructure changes before any runtime deployment.

The runtime must use exactly `ghcr.io/anomalyco/opencode:2.0.32`; never replace
the pinned tag with `latest`.

## Secret handling

Copy `.env.example` only on the deployment host or in a protected CI runtime,
then supply nonempty values through the approved secret mechanism. Do not
commit `.env`, a `secrets/` directory, private SSH keys, API keys, auth keys,
or generated backups. The committed example intentionally has blank values.

## Validate the baseline

```bash
docker compose --env-file .env.example config
bash tests/validate-config.sh
```

The compose file currently defines a profile-gated image placeholder so its
syntax can be rendered safely. The production sidecar, persistent volumes,
secret mounts, and runtime command are introduced only by their later planned
tasks.

## Dedicated Tailnet SSH identity

Never use `root`, an existing infrastructure deploy key, public IP addressing,
or an SSH configuration that disables host-key checks. An administrator with
console-authorized root access runs the provisioning script **locally on each
approved Tailnet target**, supplying only a newly generated, dedicated Ed25519
*public* key:

```bash
sudo bash scripts/provision-opencode-ssh-user.sh \
  --public-key-file /secure/operator/opencode_tailnet.pub
```

The script accepts exactly one valid `ssh-ed25519` public key and creates the
non-root `opencode` account and private `.ssh` directory only when that account
does not already exist. It locks the new account's password before adding the
exact key once. It **never repairs or provisions an existing `opencode` account**:
when one exists, it fails before any mutation, including below that account's
home directory. This also prevents `.ssh` or `authorized_keys` symlinks in an
existing home from redirecting a root write. It refuses blank, private, and
non-Ed25519 key input. It does not copy, print, or create a private key.

Build the pinned known-hosts content from a reviewed, private inventory created
out of band. Each non-comment line has the format:

```text
tailnet-hostname SHA256:fingerprint key-type base64-host-key
```

For example, after independently reviewing the hostname, public host key and
SHA256 fingerprint through an approved operator channel:

```bash
bash scripts/build-known-hosts.sh \
  --inventory /secure/operator/opencode-tailnet-hosts.reviewed \
  --output /secure/operator/opencode_known_hosts
```

The builder never calls `ssh-keyscan`; it validates every reviewed fingerprint
against the supplied key, writes a `0600` known-hosts file, and uses
`ssh-keygen -F` to confirm every hostname was pinned. Store only the dedicated
private key and the generated known-hosts content in the later repository's
GitHub Secrets. The reviewed inventory, target hostnames and fingerprints
belong in a private operator runbook, never this public repository.

Any later SSH invocation must use the dedicated identity and keep strict host
verification enabled, for example:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/run/secrets/opencode_known_hosts \
  -i /run/secrets/opencode_ssh_key \
  opencode@approved-tailnet-host true
```

Validate these safe-script contracts without connecting to any node:

```bash
bash tests/ssh-policy-contract.sh
```

## Volume backup and restore boundary

When persistent volumes are introduced, stop the application service without
volume-removal flags, archive each named volume to an operator-controlled
location, and test restoration in a non-production environment. Never use
volume-removal flags during a deploy or rollback. This baseline creates no
volumes and therefore has nothing to back up yet.

## Deployment and rollback boundary

Do not run a deployment from this baseline. A later, reviewed workflow will
render runtime-only secret files, validate the Compose contract, and start the
services without deleting volumes. Until then, rollback means reverting the
repository change; it must not affect an existing service or edge route.

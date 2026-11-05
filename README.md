# OpenCode v2 deployment baseline

This public repository contains a secret-free baseline for the isolated
OpenCode v2 deployment. It is intentionally limited to Task 1: it does not
contain runtime secrets, SSH material, a deployment workflow, edge routing, or
the Tailscale sidecar.

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

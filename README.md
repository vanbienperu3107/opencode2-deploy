# OpenCode v2 deployment baseline

This public repository contains a secret-free deployment contract for an
isolated OpenCode v2 runtime. Task 2 adds a dedicated Tailscale sidecar and
the OpenCode service, but it still contains no runtime secrets, SSH material,
deployment workflow, or edge routing.

## Prerequisites

- Docker Engine with the Compose plugin.
- Access to the GitHub repository's secret store for runtime values.
- Operator-approved infrastructure changes before any runtime deployment.

The runtime uses exactly `ghcr.io/anomalyco/opencode:2.0.32` and the Tailnet
sidecar uses exactly `tailscale/tailscale:v1.104.4`; never replace either pin
with `latest`.

## Runtime isolation

- `ts-opencode2` is the only service with `/dev/net/tun` and `NET_ADMIN`. It
  stores its separate Headscale identity in `opencode2_tailscale_state` and
  joins through `https://vpn2.hangocthanh.io.vn` as `opencode2`.
- `opencode2` shares only the sidecar network namespace, exposes no host port,
  and has no TUN device, Linux capabilities, privileged mode, Docker socket,
  host-network mode, or host-path volume mount. The external `edge` network
  reaches port `4096` through the sidecar namespace.
- The persistent named volumes are deliberately distinct:
  `opencode2_workspace` (`/workspace/projects`), `opencode2_state` (`/root`),
  and `opencode2_tailscale_state` (`/var/lib/tailscale`). Never remove them
  during a restart, update, or rollback.
- The committed config is delivered as a read-only Compose config at
  `/etc/opencode/opencode.jsonc`, not a host bind mount. It defines only the
  V2 OpenAI-compatible CLIProxy provider at
  `https://cliproxy.hangocthanh.io.vn/v1` and the required wildcard allow rule.

### Official image verification

The official `v2.0.32` image Dockerfile has no `USER` directive and installs
the binary at `/usr/local/bin/opencode`; it therefore runs as the image's
default root user. This contract intentionally does **not** invent an
`opencode` UID or `/home/opencode` path: persistent OpenCode state is mounted
at the image's actual root home (`/root`). The official V2 configuration
documentation identifies Linux managed config as `/etc/opencode/` and supports
the `@opencode/ai/providers/openai-compatible` provider package used here.

## Secret handling

Copy `.env.example` only on the deployment host or in a protected CI runtime,
then supply nonempty values through the approved secret mechanism. Do not
commit `.env`, a `secrets/` directory, private SSH keys, API keys, auth keys,
or generated backups. The committed example intentionally has blank values.

## Validate the baseline

```bash
docker compose --env-file .env.example config
python3 -m unittest -v tests.test_contracts
bash tests/compose-contract.sh
bash tests/validate-config.sh
```

The checks render the Compose model, verify that only the sidecar receives TUN
and `NET_ADMIN`, assert that the application has no public port or forbidden
host/capability grants, and validate the exact V2 CLIProxy configuration.
They do not start a runtime or authenticate to Tailnet.

## Volume backup and restore boundary

Stop the application service without volume-removal flags, archive each named
volume to an operator-controlled location, and test restoration in a
non-production environment. Never use volume-removal flags during a deploy or
rollback. The state volume can contain sessions and credentials entered at
runtime, so encrypt backups and keep them out of this repository and CI
artifacts.

## Deployment and rollback boundary

Do not run a deployment from this repository yet. A later, reviewed workflow
will verify nonempty secrets, render runtime-only SSH material, validate this
Compose contract, and start the services without deleting volumes. Until then,
rollback means reverting the repository change; it must not affect an existing
service or edge route.

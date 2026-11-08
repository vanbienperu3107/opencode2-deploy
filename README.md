# OpenCode v2 deployment baseline

This public repository contains a secret-free deployment contract for an
isolated OpenCode v2 runtime: a dedicated Tailscale sidecar, the OpenCode
service, and tooling for a dedicated Tailnet SSH identity. It contains no
runtime secrets or SSH private material.

## Prerequisites

- Docker Engine with the Compose plugin.
- Access to the GitHub repository's secret store for runtime values.
- Operator-approved infrastructure changes before any runtime deployment.

The runtime pins an exact `ghcr.io/anomalyco/opencode:<x.y.z>` version and the
Tailnet sidecar uses exactly `tailscale/tailscale:v1.104.4`; never replace either
pin with `latest`.

The `Auto-update OpenCode (vpn4)` workflow runs every six hours (and on manual
dispatch). When a newer stable release of the pinned major version is published
with a GHCR image, it bumps the pin on an `auto/opencode-<version>` branch, runs
the CI contracts, deploys that exact commit to vpn4 through `deploy.yml`, and
fast-forwards `main` only after the deploy's health and 401/200 checks pass. A
failed deploy is redeployed from the previous `main` commit and reported in an
issue. Major-version upgrades stay manual.

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
  `/etc/opencode/opencode.jsonc` and selected explicitly with
  `OPENCODE_CONFIG`, not a host bind mount. It defines only the V2
  OpenAI-compatible CLIProxy provider at
  `https://cliproxy.hangocthanh.io.vn/v1`, the required wildcard allow rule,
  and deployment default `cliproxy/deepseek-v4-flash`.

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
Production Compose fails before rendering or starting when either
`OPENCODE_SERVER_PASSWORD` or `TS_AUTHKEY` is unset or empty. CI uses only the
versioned, nonsecret placeholders in `tests/compose-ci.env` to render the
contract; that file is never a deployment env file.

### CLIProxy model inventory follow-up

`deepseek-v4-flash` is the conservative deployment default because it is a
known CLIProxy model ID in this project's verified operational inventory. The
configuration intentionally does not guess model limits or capabilities. After
deployment, query the authenticated CLIProxy `GET /v1/models` endpoint from the
runtime boundary and compare the returned inventory before adding models or
declaring model-specific limits/capabilities.

## Validate the baseline

```bash
docker compose --env-file tests/compose-ci.env config --format json
python3 -m unittest -v tests.test_contracts
bash tests/compose-contract.sh
bash tests/validate-config.sh
```

The checks parse the effective rendered Compose JSON, verify that only the
sidecar receives TUN and `NET_ADMIN`, assert the app's network/volume/config/
healthcheck isolation and nonempty required-secret interpolation, and validate
the exact V2 CLIProxy configuration. They do not start a runtime or authenticate
to Tailnet.

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
existing home from redirecting a root write. It also fails closed when the
account database lookup is inconclusive, and it never reuses a leftover home
directory left behind by a deleted account. It refuses blank, private, and
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

Stop the application service without volume-removal flags, archive each named
volume to an operator-controlled location, and test restoration in a
non-production environment. Never use volume-removal flags during a deploy or
rollback. The state volume can contain sessions and credentials entered at
runtime, so encrypt backups and keep them out of this repository and CI
artifacts.

## Deployment and rollback boundary

The manual `Deploy OpenCode v2 (vpn4)` workflow requires one non-secret input:
`ref` (the exact 40-character commit SHA to deploy). The Tailnet pre-auth key is
read from the `TS_AUTHKEY` repository secret, created by the operator on the
Headscale server (`headscale preauthkeys create --user <id> --expiration 1h`).
The workflow validates its format and passes it only to the sidecar; once the
`opencode2_tailscale_state` volume holds an identity, later deploys ignore it.

Before contacting vpn4, the workflow fail-closes on absent runtime
secrets, including `SSH_HOST_VPN4`, `SSH_USER`, `SSH_KEY`, and
`SSH_HOST_VPN4_FINGERPRINT`. The latter is the reviewed SHA256 host-key
fingerprint for vpn4 and is supplied to the pinned
`appleboy/ssh-action` commit, so host-key verification happens before the
workflow sends runtime secrets over SSH. Configure that fingerprint in the
repository secret store through an approved out-of-band verification process;
do not invent or commit a value.

The workflow renders runtime-only SSH material, validates this Compose contract,
and starts the services without deleting volumes. Rollback means manually
dispatching the same workflow with an earlier reviewed commit SHA; it must not
affect an existing service, edge route, or persistent volume.

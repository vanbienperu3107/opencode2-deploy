# The deployed image is this repository's OpenCode release plus the CLI
# tooling the agent needs. The base pin is supplied by Compose so the
# auto-update workflow only has to rewrite one place.
ARG OPENCODE_IMAGE=ghcr.io/anomalyco/opencode:2.3.2
FROM ${OPENCODE_IMAGE}

USER root

RUN apk add --no-cache \
    openssh-client \
    jq \
    github-cli \
    git \
    ncurses-terminfo-base \
    nodejs \
    npm

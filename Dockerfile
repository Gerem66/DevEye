# DevEye production image.
#
# This image installs `deveye-types` from GitHub Packages (private npm).
# Provide GITHUB_PACKAGES_TOKEN at build time. It also bakes the prebuilt agent
# binaries from the matching GitHub release into `agent/dist/` so the
# "Télécharger l'agent" UI can serve them (the repo is private — a token with
# `contents:read` is required to fetch the release assets).
#
#   docker build \
#     --build-arg GITHUB_PACKAGES_TOKEN=... \
#     --build-arg AGENT_DOWNLOAD_TOKEN=...  \   # defaults to GITHUB_PACKAGES_TOKEN
#     --build-arg AGENT_RELEASE_TAG=v1.2.3 \    # defaults to "latest"
#     -f Dockerfile \
#     -t deveye .
#
# The server is run with `tsx` (same source-of-truth as dev): the server is
# consumed as TypeScript source, and the web client is built by Vite then served
# statically by Fastify from the same origin as the API.

FROM node:22-slim AS deps
WORKDIR /app
ARG GITHUB_PACKAGES_TOKEN
ENV GITHUB_PACKAGES_TOKEN=${GITHUB_PACKAGES_TOKEN}
ENV NPM_CONFIG_USERCONFIG=/app/DevEye/.npmrc
COPY .npmrc ./DevEye/.npmrc
COPY package.json package-lock.json ./DevEye/
COPY client/package.json ./DevEye/client/
# Reproducible install from the committed lockfile. The repo is an npm workspace
# (root + client), so a single `npm ci` installs both.
RUN --mount=type=cache,target=/root/.npm \
    cd DevEye && npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY ./ ./DevEye/
# Build the web client (Vite -> DevEye/client/build). node_modules come from deps.
RUN cd DevEye/client && npm run build

# Fetch the prebuilt agent binaries (the 8-target matrix) from the matching
# GitHub release. Tolerant by design: with no token or no release, the image
# still builds and the UI simply reports every target as unavailable.
FROM alpine:3 AS agents
ARG GITHUB_PACKAGES_TOKEN
ARG AGENT_DOWNLOAD_TOKEN
ARG AGENT_RELEASE_TAG=latest
ARG AGENT_REPO=Gerem66/DevEye
RUN apk add --no-cache curl jq
WORKDIR /agents
RUN set -eu; \
    token="${AGENT_DOWNLOAD_TOKEN:-$GITHUB_PACKAGES_TOKEN}"; \
    if [ -z "${token:-}" ]; then \
      echo "⚠ no token — building without agent binaries"; exit 0; \
    fi; \
    api="https://api.github.com/repos/${AGENT_REPO}/releases"; \
    if [ "$AGENT_RELEASE_TAG" = "latest" ]; then url="$api/latest"; else url="$api/tags/$AGENT_RELEASE_TAG"; fi; \
    rel="$(curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "$url")" \
      || { echo "⚠ release fetch failed — building without agent binaries"; exit 0; }; \
    echo "$rel" | jq -r '.assets[] | select(.name | startswith("deveye-agent-")) | "\(.id) \(.name)"' \
      | while read -r id name; do \
          echo "↓ $name"; \
          curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" \
            "$api/assets/$id" -o "/agents/$name" && chmod +x "/agents/$name" || echo "⚠ failed: $name"; \
        done; \
    ls -la /agents || true

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/DevEye
# App + installed dependencies + built client.
COPY --from=build /app/DevEye ./
# Prebuilt agent binaries served by the "Télécharger l'agent" UI (may be empty).
COPY --from=agents /agents ./agent/dist
EXPOSE 3000
# Run the server through tsx (transpiles TS source on import).
CMD ["npm", "run", "start"]

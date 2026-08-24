# DevEye production image.
#
# Dependencies come from the public npm registry (`@deveye/types` included):
#
#   docker build -f Dockerfile -t deveye .
#
# The agent binaries are NOT baked here: the server reconciles them onto a
# persistent volume (AGENT_DIST_DIR) once at boot, from the rolling release. See
# src/agent/sync.ts and docker-compose.prod.yml (volume + AGENT_DOWNLOAD_TOKEN).
#
# The server is run with `tsx` (same source-of-truth as dev): the server is
# consumed as TypeScript source, and the web client is built by Vite then served
# statically by Fastify from the same origin as the API.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./DevEye/
COPY client/package.json ./DevEye/client/
# The repo is an npm workspace: root, client, AND features/* (each rapatriated
# native module is a workspace). npm ci links every workspace by symlink
# (node_modules/deveye-feature-<slug> -> ../features/<slug>), and the client's
# generated glue imports the public ones BY PACKAGE NAME — so their package.json
# must be present here, or the link is missing and vite can't resolve
# `deveye-feature-weather` at build time. Copying features/ before the install
# is what makes those workspace links exist. (.dockerignore keeps node_modules
# out; private modules are injected later under private-modules/ and resolved
# by path, not as workspaces.)
COPY features ./DevEye/features/
# Reproducible install from the committed lockfile, all workspaces at once.
RUN --mount=type=cache,target=/root/.npm \
    cd DevEye && npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY ./ ./DevEye/

# La glue des modules privés doit exister avant le build client (imports
# statiques) : stubs vides ici, l'image publique n'embarque aucun module privé.
# Un build privé écrit features.local.json et relance gen:features avant.
RUN cd DevEye && npx tsx scripts/gen-features.ts --ensure-local
# Build the web client (Vite -> DevEye/client/build). node_modules come from deps.
RUN cd DevEye/client && npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/DevEye
# `mysqldump` et `pg_dump` : les producteurs de vidage de la feature Sauvegardes.
#
# Écrire nous-mêmes un vidage aurait voulu dire reproduire, par dialecte, les
# vues, les procédures, les déclencheurs, les séquences et l'échappement exact —
# et surtout produire un fichier que seul DevEye saurait relire. Ces deux outils
# rendent du SQL qui se restaure par `mysql <` ou `psql <`, sans DevEye, ce qui
# est la définition même d'une sauvegarde.
#
# Sans eux, la feature n'échoue pas en silence : elle le dit, en nommant l'outil
# manquant (voir `src/backup/sources.ts`).
RUN apt-get update \
    && apt-get install --no-install-recommends -y default-mysql-client postgresql-client \
    && rm -rf /var/lib/apt/lists/*
# App + installed dependencies + built client.
COPY --from=build /app/DevEye ./
EXPOSE 3000
# Run the server through tsx (transpiles TS source on import).
CMD ["npm", "run", "start"]

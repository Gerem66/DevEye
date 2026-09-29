# La page d'état publique de DevEye (statut.deveye.fr), dans sa propre image :
# elle doit rester debout quand l'app tombe.
#
#   docker build -f statuspage/Dockerfile -t deveye-status .
#
# Le contexte est la racine du dépôt DevEye : la page réutilise quelques
# fichiers purs de l'app (contrat de la sonde, mise en page des alertes, style
# des pages de statut d'Uptime), réunis en un seul fichier par esbuild.
# L'image finale ne contient que ce fichier, l'icône et Node.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
# Les modules sont des workspaces : sans leur package.json, `npm ci` refuse le lockfile.
COPY features ./features/
# Aucun script d'installation : rien de natif n'entre dans le bundle.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json ./
COPY src ./src/
COPY statuspage ./statuspage/
RUN npm run build:status

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    STATUS_DB_PATH=/data/status.sqlite
WORKDIR /app
COPY --from=build /app/statuspage/dist/index.mjs ./statuspage/index.mjs
COPY --from=build /app/src/assets/deveye-icon.png ./src/assets/deveye-icon.png
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3100
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.STATUS_LISTEN_PORT || 3100) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "statuspage/index.mjs"]

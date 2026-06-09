# DevEye production image.
#
# IMPORTANT: the build context must be the PARENT directory
# (Projects/DevEye/) so the `deveye-types` package (a `file:` dependency
# shared by the server and the client) is available to npm.
#
#   docker build -f DevEye/Dockerfile -t deveye .
#
# The server is run with `tsx` (same source-of-truth as dev): deveye-types and
# the server are consumed as TypeScript source, so no separate type build or
# migration-copy step is required. The web client is built by Vite and served
# statically by Fastify from the same origin as the API.

FROM node:22-slim AS deps
WORKDIR /app
# deveye-types is referenced as `file:../DevEye-Types` (server) and
# `file:../../DevEye-Types` (client); it must exist before `npm ci`.
COPY DevEye-Types/ ./DevEye-Types/
COPY DevEye/package.json ./DevEye/
COPY DevEye/client/package.json ./DevEye/client/
# This project does not commit lockfiles, so use `npm install` (not `npm ci`).
RUN --mount=type=cache,target=/root/.npm \
    cd DevEye && npm install --no-audit --no-fund && cd client && npm install --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY DevEye/ ./DevEye/
# Build the web client (Vite -> DevEye/client/build). node_modules come from deps.
RUN cd DevEye/client && npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/DevEye
# Shared contracts (consumed as source by tsx at runtime).
COPY DevEye-Types/ /app/DevEye-Types/
# App + installed dependencies + built client.
COPY --from=build /app/DevEye ./
EXPOSE 8081
# Run the server through tsx (transpiles TS source on import).
CMD ["npm", "run", "start"]

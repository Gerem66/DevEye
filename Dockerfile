# DevEye production image.
#
# This image installs `deveye-types` from GitHub Packages (private npm).
# Provide GITHUB_PACKAGES_TOKEN at build time.
#
#   docker build \
#     --build-arg GITHUB_PACKAGES_TOKEN=... \
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
COPY package.json ./DevEye/
COPY client/package.json ./DevEye/client/
# This project does not commit lockfiles, so use `npm install` (not `npm ci`).
RUN --mount=type=cache,target=/root/.npm \
    cd DevEye && npm install --no-audit --no-fund && cd client && npm install --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY ./ ./DevEye/
# Build the web client (Vite -> DevEye/client/build). node_modules come from deps.
RUN cd DevEye/client && npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/DevEye
# App + installed dependencies + built client.
COPY --from=build /app/DevEye ./
EXPOSE 8081
# Run the server through tsx (transpiles TS source on import).
CMD ["npm", "run", "start"]

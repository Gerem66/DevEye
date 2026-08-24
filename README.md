# DevEye

## Vue d'ensemble

DevEye est une stack moderne pour le monitorage décentralisé :

- Serveur Node.js (Fastify) + MySQL orchestrent les données
- Interface web React (dossier [`client/`](./client)) les visualise
- Contrats partagés typés dans le paquet `@deveye/types` (séparé)

**Monitoring zero-knowledge**: Le serveur ne voit jamais les données en clair.

Pour les détails d'implémentation, voir [docs/architecture.md](./docs/architecture.md).

## Quick Start

Ce dépôt contient **le serveur (API Fastify)** et **le client web React** (dossier
[`client/`](./client)). Les contrats partagés vivent dans le paquet séparé
`@deveye/types` (`../DevEye-Types`, consommé en source, sans build).

### Prérequis

- [Node.js](https://nodejs.org) 22+
- [MySQL](https://www.mysql.com) 8 (ou via Docker, voir plus bas)

### 1. Configurer l'environnement

```bash
cp .env.template .env
# Renseigner DB_*, CRYPT_KEY_*, JWT_* (voir commentaires du template)
```

### 2. Installer les dépendances (serveur + client)

```bash
npm run install:all
```

### 3. Démarrer en développement (hot-reload)

```bash
npm run dev
# Serveur : tsx watch index.ts (migrations auto au démarrage)  -> http://localhost:3000
# Client  : Vite                                               -> http://localhost:5173
```

En dev, Vite (port 5173) sert le client et **proxifie** `/api` et `/ws` vers le
serveur (port 3000) : le navigateur ne parle qu'à `localhost:5173` (pas de CORS).

## Docker

### Dev — base vierge mais persistante + compte de dev

```bash
docker compose -f docker-compose.dev.yml up --build
```

Démarre un MySQL **vide et persistant** (volume nommé `deveye_dev_db`) puis l'app.
Au premier démarrage : migrations + création d'un compte de dev (`SEED_DEV=true`,
identifiants `dev` / `devdevdev` par défaut). L'app sert le client et l'API sur la
même origine : http://localhost:3000

### Prod — same-origin, DB externe (Dockploy)

```bash
cp .env.template .env   # renseigner les secrets
docker compose -f docker-compose.prod.yml up --build -d
```

Sur Dockploy, les variables sont injectées via l'UI (onglet Environment), donc le
fichier `.env` est optionnel (`required: false`). L'app sert le client buildé +
l'API sur `LISTEN_PORT` (3000) et se connecte à une base MySQL externe (ex: DB
managée par Dockploy), healthcheck sur `/api/health`.

## Licence

Projet privé — Tous droits réservés.

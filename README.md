# DevEye

## Vue d'ensemble

DevEye est une stack moderne pour le monitorage décentralisé :

- Serveur Node.js (Fastify) + MySQL orchestrent les données
- Interface web React (dossier [`client/`](./client)) les visualise
- Contrats partagés typés dans le paquet `@deveye/types` (séparé)

**Chiffré au repos, avec une clé par utilisateur.** Activez le chiffrement par
mot de passe et le serveur lui-même ne peut plus lire vos données : voir
[Docs/SECURITY_MODEL.md](./Docs/SECURITY_MODEL.md) pour ce que chaque étage
garantit.

Pour les détails d'implémentation, voir [Docs/README.md](./Docs/README.md).

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
npm install
```

### 3. Démarrer en développement (hot-reload)

```bash
npm run dev
# Serveur : tsx watch index.ts (migrations auto au démarrage)  -> http://localhost:3000
# Client  : Vite                                               -> http://localhost:5173
```

En dev, Vite (port 5173) sert le client et **proxifie** `/api` et `/ws` vers le
serveur (port 3000) : le navigateur ne parle qu'à `localhost:5173` (pas de CORS).

## Auto-hébergement

```bash
cp .env.template .env   # DB_PASSWORD et les clés : chaque commande `openssl` y figure
docker compose up -d    # http://localhost:3000
```

[docker-compose.yml](./docker-compose.yml) démarre l'app et sa base MySQL, avec
leurs volumes (les dossiers `*_STORAGE_ROOT` du `.env`, et deux volumes nommés). Le premier compte se crée par
« Créer un compte » : sur une base vide l'inscription est ouverte quel que soit
`SIGNUP_MODE`, et ce premier inscrit devient l'administrateur. Sans `SMTP_HOST`,
le lien de validation s'affiche dans le journal du serveur
(`docker compose logs app`).

L'app parle HTTP : hors de la machine locale, placez un proxy TLS devant elle et
accordez `PUBLIC_ORIGIN`.

**Avec un MySQL déjà en place**, l'app se lance seule : retirez le service `db`
et son `depends_on` du compose, et laissez `DB_HOSTNAME`, `DB_USERNAME` et
`DB_PASSWORD` du `.env` désigner votre base. Les migrations tournent au
démarrage, le healthcheck répond sur `/api/health`.

### La base du développement

```bash
docker compose -f docker-compose.dev.yml up -d   # MySQL vide et persistant, sur le port 5001
npm run dev
```

`SEED_DEV=true` dans `.env` crée un compte de dev au premier démarrage
(`dev` / `devdevdev` par défaut).

## Licence

[AGPL-3.0-only](./LICENSE) pour tout ce dépôt, agent compris. Un module qui ne
passe que par le SDK (`@deveye/types`) se licencie librement : l'exception, la
marque et les contributions sont dans [LICENSING.md](./LICENSING.md).

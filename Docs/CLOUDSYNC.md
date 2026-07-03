# CloudSync — synchronisation de dossier type « Synology Drive »

Un *partage* est un dossier « cloud » géré par le serveur, synchronisé entre
plusieurs appareils via l'agent Rust. Le serveur orchestre tout ; l'agent ne
décide jamais rien.

**Invariant absolu : rien n'est jamais détruit sans qu'une version de
sauvegarde vérifiée par hash existe déjà côté serveur.** Toute voie
destructrice (écrasement, suppression propagée, conflit, restauration) passe
par le verrou unique `src/cloudSync/versions.ts::archiveCurrent` /
`archiveBlobAsVersion`, qui refuse si le blob n'est pas physiquement présent.

## Stockage serveur

- **Blob store par partage** (`src/cloudSync/blobStore.ts`), enraciné dans le
  `storage_path` choisi à la création :
  `blobs/<h0h1>/<h2h3>/<sha256-du-clair>` + `tmp/*.part` (écritures en cours).
- Chiffré au repos (AES-256-GCM en flux, clé serveur wrappée) — voir
  `Docs/SECURITY_MODEL.md § CloudSync` et `src/cloudSync/blobCrypto.ts`.
- L'arborescence n'existe que dans MySQL (`sync_files`) ; le disque ne
  contient que des blobs opaques dédupliqués (index vivant ∪ versions
  partagent les blobs par hash ; GC uniquement via `gcBlobIfUnreferenced`,
  sous le mutex du partage).

## Tables (migration `031_cloud_sync.sql`)

| Table | Rôle |
|---|---|
| `sync_meta` | BMK wrappée (`blob_key_wrapped`) |
| `sync_shares` | partages (chemin de stockage, statut, purge auto) |
| `sync_share_devices` | appareils attachés (dossier local, statut, dernier sync) |
| `sync_exclusions` | exclusions (`path` exact, `name` de composant, `regex`) |
| `sync_files` | **index canonique** (une ligne par chemin, y compris `deleted`) |
| `sync_device_files` | **baseline par appareil** — la 3ᵉ voie du merge |
| `sync_versions` | corbeille/versions (raison : overwrite/delete/conflict/restore/excluded) |
| `sync_sessions` | progression persistée + sessions orphelines soldées |
| `sync_events` | journal par partage (erreurs datées, fichier + appareil) — popup « Logs », rétention 90 j |

L'unicité des chemins passe par `rel_path_hash` (SHA-256 du chemin relatif
NFC-normalisé) : un `VARCHAR(1024)` ne tient pas dans un index unique utf8mb4.

## Algorithme (merge 3 voies, orchestré serveur)

Session par (partage × appareil), sérialisée par partage (mutex dans
`engine.ts` — sessions, purge, restauration et GC ne se croisent jamais) :

1. **Scan** : l'agent parcourt le dossier local (exclusions appliquées,
   symlinks ignorés, hashing incrémental via cache size+mtime) et streame des
   lots `sync.index` (≤ 500 entrées).
2. **Plan** : `planner.ts` (pur, sans I/O) croise *appareil* / *baseline* /
   *index serveur*. Règle d'or : **une suppression n'est jamais inférée sans
   ligne de baseline** — premier sync ou ré-attachement = merge pur, zéro
   suppression possible. Conflits (gagnant = last-writer-wins sur le mtime,
   tolérance 5 s, égalité = serveur) selon la politique du partage :
   `newest` = le perdant est archivé en version ; `rename` = le perdant reste
   VIVANT sous `<nom> (conflit AAAA-MM-JJ HH-MM-SS).<ext>` et se propage
   partout comme un fichier normal.
3. **Transferts** (séquentiels, atomiques, ordres stricts) :
   - upload : blob vérifié par hash → archive de l'ancien → index → baseline ;
   - download : chunks acquittés (fenêtre 4) → install atomique agent
     (tmp + vérif hash/taille + mtime + rename) → `opResult ok` → baseline ;
   - suppression serveur : archive → `state='deleted'` → baseline ;
   - suppression appareil : le serveur vérifie qu'une version de CE contenu
     existe, puis l'agent déplace vers `.deveye-trash/<horodatage>/…`
     (jamais de unlink ; purge locale > 30 j).
4. La progression (totaux connus dès le plan → vraie barre) est poussée aux
   abonnés web (`cloudSync.progress`/`cloudSync.state`, abonnement par
   partage) et persistée ~2 s.

Déclencheurs : connexion d'agent, watcher local débouncé (`notify`, 2 s de
calme / 30 s max — il ne porte aucune vérité, il déclenche un scan),
changement de config, **propagation croisée** (une session qui a modifié
l'index canonique re-planifie immédiatement les autres appareils du partage —
c'est ce qui rend la synchro « en direct » de A vers B), et un **filet
horaire** (`scheduleAllActive` dans le prune : un événement de watcher raté ne
laisse jamais deux appareils divergents plus d'une heure). Une session
interrompue n'importe où se relance depuis le scan et converge (idempotence).

**Exclusions** : un chemin exclu devient invisible au merge (ni envoyé, ni
téléchargé, ni supprimé) ET est retiré du cloud à l'ajout de la règle —
archivé en version (`excluded`, restaurable), marqué supprimé, baselines
purgées. Les copies locales des appareils restent intactes.

**Journal** : chaque échec par fichier (chemin refusé, collision de casse,
fichier illisible, install refusée…) et chaque session en erreur est consigné
dans `sync_events` — visible dans la popup « Logs » de la feature (message,
date, fichier, appareil).

## Fichiers

- **Types** : `DevEye-Types/src/domain/cloudSync.ts`,
  `features/cloudSync.ts`, protocole agent dans `protocol/agent.ts`
  (`sync.config/scan/push/applyChunk/delete` ↓, `sync.changed/index/chunk/ack/opResult` ↑).
- **Serveur** : `src/cloudSync/` (blobCrypto, blobStore, pathValidation,
  exclusions, planner, versions, session, engine, prune), handlers agent
  `src/agent/handlers/sync.ts`, commandes `src/features/cloudSync/`,
  repos `src/db/repos/sync*.ts`.
- **Agent** : `agent/src/sync/` (paths — `safe_join` est LE portail
  anti-traversée —, scanner, index_cache, watcher, transfer, mod).
- **Client** : `client/src/Features/CloudSync/` (héros d'état, wizard,
  appareils, exclusions, versions, réglages), store
  `client/src/stores/cloudSync.ts`, entrée catalogue `cloudsync`.

## Test E2E local

Deux agents sur une machine via `DEVEYE_CONFIG` (deux configs + deux dossiers
locaux), un partage vers un dossier de brouillon, puis : merge initial,
propagation watcher, conflit d'édition double (perdant visible dans Versions),
suppression propagée (version serveur + `.deveye-trash` chez le pair),
pause/reprise aux deux niveaux, coupure serveur mi-transfert puis relance
(convergence), restauration/téléchargement d'une version, purge auto avec une
petite limite.

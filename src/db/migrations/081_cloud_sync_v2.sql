-- CloudSync : finitions de production.
--
-- Trois apports, tous nécessaires à l'objectif « le dossier est identique sur
-- macOS, Linux et Windows EN TOUT TEMPS » :
--
-- 1. `kind` — l'index ne connaissait que des fichiers. Un dossier VIDE n'existait
--    donc sur aucun autre appareil, et un dossier vidé restait en coquille chez
--    les pairs. Seuls les dossiers vides sont indexés (`kind = 'dir'`) : un
--    dossier peuplé est implicite, ses fichiers le recréent partout.
--
-- 2. `mode` — les permissions Unix n'étaient pas transportées : un script
--    perdait son bit exécutable en faisant Linux → Windows → Linux. NULL veut
--    dire « aucun agent Unix ne l'a encore vu » ; un agent Windows renvoie NULL
--    et le serveur CONSERVE alors la valeur en base au lieu de l'effacer.
--
-- 3. `sync_snapshots` / `sync_snapshot_files` — point de restauration du dossier
--    complet. `sync_versions` est une corbeille PAR FICHIER : elle ne permet pas
--    de revenir à « l'état du partage tel qu'il était mardi à 14 h ». Un snapshot
--    ne copie AUCUN octet : c'est une photo de l'index, les blobs étant déjà
--    dédupliqués et partagés par hash.
--
--    Conséquence critique, implémentée dans src/db/repos/syncFiles.ts :
--    `isHashReferenced` (la porte du GC de blobs) doit AUSSI regarder
--    `sync_snapshot_files`, sinon la purge des versions détruirait des blobs
--    qu'un snapshot est seul à référencer, et la restauration deviendrait
--    impossible.
--
-- Les valeurs par défaut sont exactes pour l'existant (tout est `file`, mode
-- inconnu) : aucune remise à zéro des données n'est nécessaire.

-- Les DDL de MySQL committent implicitement : une migration qui casse au
-- milieu reste à moitié appliquée SANS être enregistrée dans `_migrations`, et
-- la relance butterait sur les colonnes déjà là. Chaque ajout est donc gardé,
-- comme dans 071.

-- ─── 1 & 2 : nature et permissions des entrées d'index ──────────────────────

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND COLUMN_NAME = 'kind');
SET @s = IF(@c = 0,
    "ALTER TABLE sync_files ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'file' AFTER rel_path_hash",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND COLUMN_NAME = 'mode');
SET @s = IF(@c = 0, 'ALTER TABLE sync_files ADD COLUMN mode SMALLINT NULL AFTER mtime', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_device_files' AND COLUMN_NAME = 'kind');
SET @s = IF(@c = 0,
    "ALTER TABLE sync_device_files ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'file' AFTER rel_path_hash",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_device_files' AND COLUMN_NAME = 'mode');
SET @s = IF(@c = 0, 'ALTER TABLE sync_device_files ADD COLUMN mode SMALLINT NULL AFTER mtime', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── 3 : sauvegardes point-in-time ──────────────────────────────────────────

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND COLUMN_NAME = 'snapshot_enabled');
SET @s = IF(@c = 0,
    'ALTER TABLE sync_shares
         ADD COLUMN snapshot_enabled        TINYINT NOT NULL DEFAULT 1,
         ADD COLUMN snapshot_interval_hours INT     NOT NULL DEFAULT 6,
         ADD COLUMN snapshot_keep_days      INT     NOT NULL DEFAULT 90',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Un point de restauration. `kind` :
--   `auto`       — pris par l'entretien horaire quand l'index a bougé ;
--   `manual`     — demandé depuis l'interface ;
--   `preRestore` — pris juste AVANT une restauration, ce qui la rend annulable.
CREATE TABLE IF NOT EXISTS sync_snapshots (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    share_id    INT          NOT NULL,
    kind        VARCHAR(16)  NOT NULL DEFAULT 'auto',
    label       VARCHAR(120) NULL,
    file_count  INT          NOT NULL DEFAULT 0,
    total_bytes BIGINT       NOT NULL DEFAULT 0,
    created     BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_sync_snapshots_share (share_id, created),
    CONSTRAINT fk_sync_snapshot_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Le contenu d'un snapshot : une ligne par chemin vivant à l'instant T.
-- `hash` est indexé parce que c'est la jointure du GC de blobs.
CREATE TABLE IF NOT EXISTS sync_snapshot_files (
    snapshot_id   BIGINT        NOT NULL,
    rel_path      VARCHAR(1024) NOT NULL,
    rel_path_hash CHAR(64)      NOT NULL,
    kind          VARCHAR(8)    NOT NULL DEFAULT 'file',
    hash          CHAR(64)      NOT NULL,
    size          BIGINT        NOT NULL,
    mtime         BIGINT        NOT NULL,
    mode          SMALLINT      NULL,
    PRIMARY KEY (snapshot_id, rel_path_hash),
    KEY idx_sync_snapshot_files_hash (hash),
    CONSTRAINT fk_sync_snapshot_file_snapshot FOREIGN KEY (snapshot_id) REFERENCES sync_snapshots(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

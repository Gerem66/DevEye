-- CloudSync : finitions de production.
--
-- 1. `kind` : seuls les dossiers vides sont indexés (`kind = 'dir'`), un
--    dossier peuplé est implicite. Sans ça un dossier vide n'existait sur aucun
--    autre appareil.
-- 2. `mode` : permissions Unix. NULL = aucun agent Unix ne l'a encore vu, et le
--    serveur CONSERVE alors la valeur en base au lieu de l'effacer.
-- 3. `sync_snapshots` / `sync_snapshot_files` : point de restauration du dossier
--    complet, photo de l'index sans copier un octet (blobs partagés par hash).
--    `isHashReferenced` (src/db/repos/syncFiles.ts) doit AUSSI regarder
--    `sync_snapshot_files`, sinon le GC détruirait des blobs qu'un snapshot est
--    seul à référencer.
--
-- Chaque ajout est gardé (INFORMATION_SCHEMA) : une migration qui casse au
-- milieu reste à moitié appliquée et se rejoue.

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

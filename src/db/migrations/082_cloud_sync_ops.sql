-- CloudSync : réglages d'exploitation, par partage, avec des défauts qui
-- reproduisent le comportement d'avant.
--
-- 1. `rate_up_bps` / `rate_down_bps` : NULL = illimité. Le limiteur vit chez
--    l'émetteur : le serveur pour les descentes, l'agent pour les montées.
-- 2. `trash_keep_days` : corbeille locale de l'agent (`.deveye-trash/`).
-- 3. `integrity_scan_enabled` : balayage d'intégrité de fond (tag GCM +
--    SHA-256 sur un petit budget de blobs par tour). La position courante vit
--    dans `sync_meta`.
--
-- Ajout gardé (INFORMATION_SCHEMA) : une migration qui casse au milieu reste à
-- moitié appliquée et se rejoue.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND COLUMN_NAME = 'rate_up_bps');
SET @s = IF(@c = 0,
    'ALTER TABLE sync_shares
         ADD COLUMN rate_up_bps            BIGINT  NULL,
         ADD COLUMN rate_down_bps          BIGINT  NULL,
         ADD COLUMN trash_keep_days        INT     NOT NULL DEFAULT 30,
         ADD COLUMN integrity_scan_enabled TINYINT NOT NULL DEFAULT 1',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

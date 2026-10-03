-- Journal CloudSync : niveau (erreur a gerer ou simple avis), compteur de
-- repetitions, premiere occurrence et date de reglement. Garde par
-- INFORMATION_SCHEMA : ne fait rien la ou la colonne existe deja.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_events' AND COLUMN_NAME = 'level');
SET @s = IF(@c = 0,
    'ALTER TABLE sync_events
        ADD COLUMN level ENUM(''error'', ''notice'') NOT NULL DEFAULT ''error'' AFTER message,
        ADD COLUMN `count` INT UNSIGNED NOT NULL DEFAULT 1 AFTER level,
        ADD COLUMN first_seen BIGINT NOT NULL DEFAULT 0 AFTER `count`,
        ADD COLUMN resolved BIGINT NULL AFTER created,
        ADD KEY idx_sync_events_open (share_id, resolved, created)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
UPDATE sync_events SET first_seen = created WHERE first_seen = 0;

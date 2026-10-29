-- CloudSync : sessions incrémentales. Par paire partage x appareil, l'empreinte
-- de la baseline que le serveur tient (NULL = inconnue, la prochaine session
-- recharge tout) et l'instant du dernier plan mené à bout, d'où une session
-- relit les seules lignes de l'index modifiées depuis. L'index des chemins
-- sert aux homonymes à la casse près (collation general_ci). Ajouts
-- conditionnels via INFORMATION_SCHEMA.
SET @ssd_fingerprint_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_share_devices' AND COLUMN_NAME = 'baseline_fingerprint');
SET @add_ssd_fingerprint = IF(@ssd_fingerprint_exists = 0,
    'ALTER TABLE sync_share_devices ADD COLUMN baseline_fingerprint VARCHAR(128) DEFAULT NULL AFTER last_sync_at',
    'SELECT 1');
PREPARE stmt FROM @add_ssd_fingerprint; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ssd_planned_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_share_devices' AND COLUMN_NAME = 'planned_at');
SET @add_ssd_planned = IF(@ssd_planned_exists = 0,
    'ALTER TABLE sync_share_devices ADD COLUMN planned_at BIGINT DEFAULT NULL AFTER baseline_fingerprint',
    'SELECT 1');
PREPARE stmt FROM @add_ssd_planned; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sync_files_updated_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND INDEX_NAME = 'idx_sync_files_updated');
SET @add_sync_files_updated = IF(@sync_files_updated_exists = 0,
    'ALTER TABLE sync_files ADD KEY idx_sync_files_updated (share_id, updated)',
    'SELECT 1');
PREPARE stmt FROM @add_sync_files_updated; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sync_files_path_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND INDEX_NAME = 'idx_sync_files_path');
SET @add_sync_files_path = IF(@sync_files_path_exists = 0,
    'ALTER TABLE sync_files ADD KEY idx_sync_files_path (share_id, rel_path(255))',
    'SELECT 1');
PREPARE stmt FROM @add_sync_files_path; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- CloudSync : index couvrants des totaux d'un partage (nombre et volume des
-- fichiers présents, des versions), lus à chaque liste des partages. Sans eux,
-- chaque total ouvre toutes les lignes complètes du partage : plusieurs
-- secondes sur un partage de centaines de milliers de fichiers dès que la
-- table ne tient plus en mémoire. Ajout conditionnel via INFORMATION_SCHEMA.
SET @sync_files_stats_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND INDEX_NAME = 'idx_sync_files_stats');
SET @add_sync_files_stats = IF(@sync_files_stats_exists = 0,
    'ALTER TABLE sync_files ADD KEY idx_sync_files_stats (share_id, state, size)',
    'SELECT 1');
PREPARE stmt FROM @add_sync_files_stats; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sync_versions_size_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_versions' AND INDEX_NAME = 'idx_sync_versions_size');
SET @add_sync_versions_size = IF(@sync_versions_size_exists = 0,
    'ALTER TABLE sync_versions ADD KEY idx_sync_versions_size (share_id, size)',
    'SELECT 1');
PREPARE stmt FROM @add_sync_versions_size; EXECUTE stmt; DEALLOCATE PREPARE stmt;

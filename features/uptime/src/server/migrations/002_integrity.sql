-- Un second type de controle : l'integrite des fichiers d'un site (empreintes
-- SHA-256 comparees a une reference apprise). `kind` aiguille la sonde sans
-- dechiffrer, `baseline_enc` porte la reference, chiffree a l'etage ouvert.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, refusee par MySQL).
SET @kind_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'kind'
);
SET @add_kind = IF(
    @kind_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT ''http'' AFTER content',
    'SELECT 1'
);
PREPARE stmt FROM @add_kind;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @baseline_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'baseline_enc'
);
SET @add_baseline = IF(
    @baseline_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN baseline_enc TEXT NULL AFTER last_error',
    'SELECT 1'
);
PREPARE stmt FROM @add_baseline;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

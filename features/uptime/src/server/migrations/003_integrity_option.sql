-- L'integrite des fichiers devient une option d'un service HTTP au lieu d'un
-- type de controle. `integrity_interval_seconds` NULL : option eteinte.
-- `integrity_checked_at` et `integrity_failures` planifient la lecture des
-- fichiers sans dechiffrer, `integrity_verdict` porte l'ecart qui tient les
-- mesures en echec jusqu'a resolution, chiffre a l'etage ouvert.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, refusee par MySQL).
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'integrity_interval_seconds'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN integrity_interval_seconds INT NULL AFTER baseline_enc',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'integrity_checked_at'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN integrity_checked_at BIGINT NULL AFTER integrity_interval_seconds',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'integrity_failures'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN integrity_failures INT NOT NULL DEFAULT 0 AFTER integrity_checked_at',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'integrity_verdict'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN integrity_verdict TEXT NULL AFTER integrity_failures',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Un ancien controle d'integrite garde sa cadence pour la lecture des fichiers,
-- sa reference et son historique. Sa date de lecture reste NULL : la premiere
-- sonde relit le site, et retrouve un ecart en cours.
SET @kind_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'kind'
);
SET @dml = IF(
    @kind_exists = 1,
    'UPDATE uptime_services SET integrity_interval_seconds = interval_seconds WHERE kind = ''integrity''',
    'SELECT 1'
);
PREPARE stmt FROM @dml;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    @kind_exists = 1,
    'ALTER TABLE uptime_services DROP COLUMN kind',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

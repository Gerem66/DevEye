-- Une mesure que les seuls fichiers ont fait echouer (la page repond, mais un
-- ecart ou une lecture ratee la tient en echec) est marquee : une validation
-- « mise a jour » la rend reussie, et la page publique la compte reussie.
-- Le cumul journalier porte le compte de ces echecs, l'incident dit s'il a
-- ete ouvert par les fichiers.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, refusee par MySQL).
SET @checks_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_checks' AND COLUMN_NAME = 'integrity_down'
);
SET @add_checks = IF(
    @checks_exists = 0,
    'ALTER TABLE uptime_checks ADD COLUMN integrity_down TINYINT NOT NULL DEFAULT 0 AFTER up',
    'SELECT 1'
);
PREPARE stmt FROM @add_checks;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @daily_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_daily' AND COLUMN_NAME = 'integrity_down'
);
SET @add_daily = IF(
    @daily_exists = 0,
    'ALTER TABLE uptime_daily ADD COLUMN integrity_down INT NOT NULL DEFAULT 0 AFTER up_checks',
    'SELECT 1'
);
PREPARE stmt FROM @add_daily;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @incidents_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_incidents' AND COLUMN_NAME = 'integrity_down'
);
SET @add_incidents = IF(
    @incidents_exists = 0,
    'ALTER TABLE uptime_incidents ADD COLUMN integrity_down TINYINT NOT NULL DEFAULT 0 AFTER http_status',
    'SELECT 1'
);
PREPARE stmt FROM @add_incidents;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

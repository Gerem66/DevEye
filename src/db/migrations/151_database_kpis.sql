-- Les indicateurs d'une base : des requêtes qui rendent un nombre, montrées en
-- tuiles sur sa fiche. `kpis` porte leurs définitions, `kpi_values` leurs
-- dernières mesures, chiffrées l'une et l'autre : une requête dit ce que contient
-- la base, une mesure ce qu'elle vaut.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB).

SET @database_kpis_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_connections' AND COLUMN_NAME = 'kpis');
SET @add_database_kpis = IF(@database_kpis_exists = 0,
    'ALTER TABLE database_connections ADD COLUMN kpis TEXT NULL, ADD COLUMN kpi_values TEXT NULL',
    'SELECT 1');
PREPARE stmt FROM @add_database_kpis; EXECUTE stmt; DEALLOCATE PREPARE stmt;

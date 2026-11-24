-- L'etage sous lequel une base garde ses deux secrets (son mot de passe, le
-- secret de son acces). `open` : la cle de l'espace, que le serveur ouvre seul
-- pour la relever et l'alerter. `guarded` : la cle que le mot de passe du compte
-- protege, hors de portee d'une tache de fond. Le reste de la fiche (nom, hote,
-- dernier releve) est a l'etage ouvert dans les deux cas.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB).

SET @database_tier_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_connections' AND COLUMN_NAME = 'security_tier');
SET @add_database_tier = IF(@database_tier_exists = 0,
    'ALTER TABLE database_connections ADD COLUMN security_tier ENUM(''open'',''guarded'') NOT NULL DEFAULT ''open'' AFTER engine',
    'SELECT 1');
PREPARE stmt FROM @add_database_tier; EXECUTE stmt; DEALLOCATE PREPARE stmt;

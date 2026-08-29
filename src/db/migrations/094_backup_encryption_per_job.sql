-- Le chiffrement des archives se règle par TRAVAIL, plus par destination :
-- chaque travail porte `encryption` ('none' | 'server'), et `backup_runs.encrypted`
-- continue de figer la forme réellement écrite.
--
-- Reprise : chaque travail hérite du drapeau de sa destination. Les travaux
-- créés ensuite naissent en 'server'.
--
-- Rejouable : la colonne s'ajoute sous garde d'absence, le report et la
-- suppression du drapeau sont gardés par la PRÉSENCE de
-- `backup_destinations.encrypt`.

SET @has_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_jobs' AND COLUMN_NAME = 'encryption');

SET @s = IF(@has_col = 0,
    "ALTER TABLE backup_jobs ADD COLUMN encryption VARCHAR(16) NOT NULL DEFAULT 'server' AFTER keep_last",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_flag = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_destinations' AND COLUMN_NAME = 'encrypt');

SET @s = IF(@has_flag = 1, "
UPDATE backup_jobs j
  JOIN backup_destinations d ON d.id = j.destination_id
   SET j.encryption = IF(d.encrypt = 1, 'server', 'none')", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_flag = 1, 'ALTER TABLE backup_destinations DROP COLUMN encrypt', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

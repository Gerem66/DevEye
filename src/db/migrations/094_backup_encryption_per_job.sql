-- Le chiffrement des archives se règle par TRAVAIL, plus par destination.
--
-- Une destination dit où écrire ; c'est le travail qui dit sous quelle forme.
-- Le drapeau `encrypt` de la destination faisait dépendre la forme de TOUTES
-- les archives d'un choix fait ailleurs, invisible depuis le travail. Chaque
-- travail porte désormais `encryption` ('none' | 'server'), réglé dans
-- l'onglet Chiffrement de ses réglages, et chaque exécution continue de figer
-- la forme réellement écrite (`backup_runs.encrypted`, inchangé).
--
-- ## Ce que la reprise préserve
--
-- Chaque travail hérite du drapeau de sa destination : ce qui était scellé
-- hier le reste demain, ce qui était en clair aussi. Les travaux créés ensuite
-- naissent en 'server' (le défaut de colonne, et celui du formulaire).
--
-- ## Rejouabilité
--
-- La colonne `encryption` s'ajoute sous garde d'absence ; le report et la
-- suppression du drapeau de destination sont gardés par la PRÉSENCE de
-- `backup_destinations.encrypt` : une fois le drapeau tombé, plus rien ne
-- rejoue. Un rejeu interrompu entre le report et la suppression refait un
-- report identique (idempotent) puis supprime.

-- ── La colonne du travail ───────────────────────────────────────────────────

SET @has_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_jobs' AND COLUMN_NAME = 'encryption');

SET @s = IF(@has_col = 0,
    "ALTER TABLE backup_jobs ADD COLUMN encryption VARCHAR(16) NOT NULL DEFAULT 'server' AFTER keep_last",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Report du drapeau de destination, puis sa disparition ───────────────────

SET @has_flag = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_destinations' AND COLUMN_NAME = 'encrypt');

SET @s = IF(@has_flag = 1, "
UPDATE backup_jobs j
  JOIN backup_destinations d ON d.id = j.destination_id
   SET j.encryption = IF(d.encrypt = 1, 'server', 'none')", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_flag = 1, 'ALTER TABLE backup_destinations DROP COLUMN encrypt', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

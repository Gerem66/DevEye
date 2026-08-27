-- La clé étrangère des travaux vers leur destination passe de RESTRICT à
-- CASCADE.
--
-- Le RESTRICT de la 086 voulait protéger la configuration de quelqu'un : ne
-- pas effacer en silence les travaux qui visent une destination qu'on retire.
-- Mais cette garde vit déjà dans le handler (`backup.destinationRemove`
-- refuse, en disant combien de travaux bloquent), et la clé étrangère
-- mordait ailleurs : supprimer un ESPACE cascade `workspaces` vers
-- `backup_destinations` pendant que `backup_jobs` (cascadé lui aussi par
-- l'espace, mais dans un ordre que MySQL ne garantit pas) référence encore
-- ces destinations. `workspace.delete` échouait sur
-- `fk_bkp_job_destination` pour tout espace ayant au moins un travail, sans
-- qu'aucun écran ne puisse le dire.
--
-- Rejouable : la règle est lue dans INFORMATION_SCHEMA avant de toucher à la
-- contrainte, et le second pas est gardé par l'absence de la contrainte. Un
-- rejeu interrompu entre les deux ne refait que le pas manquant.

SET @rule = (SELECT DELETE_RULE FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
              WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_jobs'
                AND CONSTRAINT_NAME = 'fk_bkp_job_destination');

SET @s = IF(@rule IN ('RESTRICT', 'NO ACTION'),
    'ALTER TABLE backup_jobs DROP FOREIGN KEY fk_bkp_job_destination',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_jobs'
             AND CONSTRAINT_NAME = 'fk_bkp_job_destination');

SET @s = IF(@c = 0,
    'ALTER TABLE backup_jobs ADD CONSTRAINT fk_bkp_job_destination FOREIGN KEY (destination_id) REFERENCES backup_destinations(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

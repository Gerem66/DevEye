-- La clé étrangère des travaux vers leur destination passe de RESTRICT à
-- CASCADE. Le refus de retirer une destination encore visée vit dans le
-- handler (`backup.destinationRemove`). En RESTRICT, supprimer un espace
-- cascadait `workspaces` vers `backup_destinations` pendant que `backup_jobs`
-- les référençait encore (ordre non garanti par MySQL) et `workspace.delete`
-- échouait sur `fk_bkp_job_destination`.
--
-- Rejouable : chaque pas est gardé par l'état lu dans INFORMATION_SCHEMA.

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

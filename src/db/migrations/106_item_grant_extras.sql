-- Une restriction par élément ne portait qu'un niveau (masqué, lecture seule).
-- Elle porte aussi, désormais, les permissions propres de la fonctionnalité que
-- cet élément-ci refuse au rôle : donner le terminal à un rôle sans le lui
-- donner sur CETTE machine.
--
-- `access` devient donc nullable : une ligne peut n'exister que pour des
-- permissions refusées, sans exception de niveau. L'absence de ligne reste
-- « rien de particulier », et une ligne dont les deux volets sont vides est
-- supprimée plutôt qu'écrite à neutre.
--
-- Rejouable : chaque changement est gardé par la lecture d'INFORMATION_SCHEMA.

SET @n = (SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_role_grants'
            AND COLUMN_NAME = 'access');
SET @s = IF(@n = 'NO', 'ALTER TABLE item_role_grants MODIFY COLUMN access VARCHAR(8) NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_role_grants'
            AND COLUMN_NAME = 'denied_extras');
SET @s = IF(@c = 0,
    'ALTER TABLE item_role_grants ADD COLUMN denied_extras JSON NULL AFTER access',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

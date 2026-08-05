-- Uptime passe au scope espace.
--
-- `uptime_services.workspace_id` existait deja mais etait nullable et n'entrait
-- dans aucune clause WHERE : les handlers listaient par `user_id` puis
-- filtraient en JS. NULL (« espace personnel ») devient l'id reel, et la colonne
-- passe NOT NULL.
--
-- `uptime_settings` etait un singleton par compte ; il devient un singleton par
-- espace. La bascule est 1:1 sans collision possible, puisque chaque `user_id`
-- correspond a exactement un espace personnel.
--
-- Rien n'est re-chiffre : les colonnes chiffrees de ces tables le sont par la
-- DEK ouverte de l'utilisateur, et l'espace personnel resout precisement cette
-- cle (cf. 046). Voir aussi `SecureStore.createOpenCipher`.
--
-- Ajouts de colonnes toujours via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (cf. 038 : cette clause a fait tomber la prod).

-- 1. uptime_services : backfill du NULL vers l'espace personnel du proprietaire.
UPDATE uptime_services s
JOIN users u ON u.id = s.user_id
SET s.workspace_id = u.personal_workspace_id
WHERE s.workspace_id IS NULL;

ALTER TABLE uptime_services MODIFY COLUMN workspace_id INT NOT NULL;

-- Les rangs etaient numerotes par (utilisateur, espace) ; ils doivent l'etre par
-- espace seul, sinon deux membres d'un meme espace partage produiraient des
-- rangs qui se telescopent. Motif idempotent : renumerotation depuis l'ordre
-- courant, donc rejouer ne change rien.
UPDATE uptime_services s
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY sort_order ASC, id ASC) - 1 AS rn
    FROM uptime_services
) r ON r.id = s.id
SET s.sort_order = r.rn;

-- 2. uptime_settings : la cle primaire passe du compte a l'espace.
--    La FK vers `users` doit partir avant que `user_id` ne puisse etre supprime.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_settings' AND COLUMN_NAME = 'workspace_id');
SET @s = IF(@c = 0, 'ALTER TABLE uptime_settings ADD COLUMN workspace_id INT NULL FIRST', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill + purge des orphelins, gardes : au rejeu, `user_id` a disparu.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_settings' AND COLUMN_NAME = 'user_id');
SET @s = IF(@c > 0,
    'UPDATE uptime_settings t JOIN users u ON u.id = t.user_id SET t.workspace_id = u.personal_workspace_id WHERE t.workspace_id IS NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@c > 0, 'DELETE FROM uptime_settings WHERE workspace_id IS NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE uptime_settings MODIFY COLUMN workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_settings'
            AND CONSTRAINT_NAME = 'fk_uptime_settings_user');
SET @s = IF(@c > 0, 'ALTER TABLE uptime_settings DROP FOREIGN KEY fk_uptime_settings_user', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_settings' AND COLUMN_NAME = 'user_id');
SET @s = IF(@c > 0,
    'ALTER TABLE uptime_settings DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id), DROP COLUMN user_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_settings'
            AND CONSTRAINT_NAME = 'fk_uptime_settings_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE uptime_settings ADD CONSTRAINT fk_uptime_settings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

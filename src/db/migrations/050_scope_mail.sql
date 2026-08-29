-- Mail passe au scope espace. Seule `mail_accounts` gagne la colonne : dossiers
-- et messages sont rattaches a leur compte, donc cloisonner la racine cloisonne
-- tout l'arbre. `mail_settings` suit le meme changement de cle primaire
-- qu'`uptime_settings`. Rien n'est re-chiffre (cf. 049).

-- 1. mail_accounts.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts' AND COLUMN_NAME = 'workspace_id');
SET @s = IF(@c = 0, 'ALTER TABLE mail_accounts ADD COLUMN workspace_id INT NULL AFTER user_id', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE mail_accounts a
JOIN users u ON u.id = a.user_id
SET a.workspace_id = u.personal_workspace_id
WHERE a.workspace_id IS NULL;

ALTER TABLE mail_accounts MODIFY COLUMN workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts' AND INDEX_NAME = 'idx_mail_accounts_workspace');
SET @s = IF(@c = 0, 'ALTER TABLE mail_accounts ADD KEY idx_mail_accounts_workspace (workspace_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts'
            AND CONSTRAINT_NAME = 'fk_mail_account_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE mail_accounts ADD CONSTRAINT fk_mail_account_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Rangs par espace plutot que par compte.
UPDATE mail_accounts a
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY sort_order ASC, id ASC) - 1 AS rn
    FROM mail_accounts
) r ON r.id = a.id
SET a.sort_order = r.rn;

-- 2. mail_settings : cle primaire du compte vers l'espace.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings' AND COLUMN_NAME = 'workspace_id');
SET @s = IF(@c = 0, 'ALTER TABLE mail_settings ADD COLUMN workspace_id INT NULL FIRST', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings' AND COLUMN_NAME = 'user_id');
SET @s = IF(@c > 0,
    'UPDATE mail_settings t JOIN users u ON u.id = t.user_id SET t.workspace_id = u.personal_workspace_id WHERE t.workspace_id IS NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@c > 0, 'DELETE FROM mail_settings WHERE workspace_id IS NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE mail_settings MODIFY COLUMN workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings'
            AND CONSTRAINT_NAME = 'fk_mail_settings_user');
SET @s = IF(@c > 0, 'ALTER TABLE mail_settings DROP FOREIGN KEY fk_mail_settings_user', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings' AND COLUMN_NAME = 'user_id');
SET @s = IF(@c > 0,
    'ALTER TABLE mail_settings DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id), DROP COLUMN user_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings'
            AND CONSTRAINT_NAME = 'fk_mail_settings_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE mail_settings ADD CONSTRAINT fk_mail_settings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

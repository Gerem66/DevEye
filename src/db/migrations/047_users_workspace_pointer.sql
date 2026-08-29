-- `users` pointe vers ses espaces, et perd ce qui a déménagé dessus (046).
--
--   - `personal_workspace_id` : obligatoire, UNIQUE (c'est cette contrainte qui
--     garantit « au plus un espace personnel par compte », sans limiter le
--     nombre d'espaces partagés possédés). Accès O(1) pour les jobs de fond.
--   - `default_workspace_id` : l'espace favori, chargé en premier. NULL =
--     l'espace personnel, ce que valait l'ancien `default_workspace = 0`.

-- 1. Pointeur vers l'espace personnel.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'personal_workspace_id');
SET @s = IF(@c = 0,
    'ALTER TABLE users ADD COLUMN personal_workspace_id INT NULL AFTER role',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE users u
SET u.personal_workspace_id = (
    SELECT w.id FROM workspaces w WHERE w.kind = 'personal' AND w.owner_user_id = u.id LIMIT 1
)
WHERE u.personal_workspace_id IS NULL;

ALTER TABLE users MODIFY COLUMN personal_workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uniq_personal_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE users ADD UNIQUE KEY uniq_personal_workspace (personal_workspace_id)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Le favori. Pas de FK CASCADE ici : perdre l'accès à son espace favori doit
--    remettre le favori à zéro, pas supprimer le compte.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'default_workspace_id');
SET @s = IF(@c = 0,
    'ALTER TABLE users ADD COLUMN default_workspace_id INT NULL AFTER personal_workspace_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'fk_user_default_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE users ADD CONSTRAINT fk_user_default_workspace FOREIGN KEY (default_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'default_workspace');
SET @s = IF(@c > 0, 'ALTER TABLE users DROP COLUMN default_workspace', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. État du compte au niveau du site : `suspended` refuse la connexion sans
--    rien détruire.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'status');
SET @s = IF(@c = 0,
    "ALTER TABLE users ADD COLUMN status ENUM('active','suspended') NOT NULL DEFAULT 'active' AFTER role",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Ce qui a déménagé sur l'espace personnel en 046 disparaît du compte : des
--    doublons qui divergeraient silencieusement.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'features');
SET @s = IF(@c > 0, 'ALTER TABLE users DROP COLUMN features', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'theme');
SET @s = IF(@c > 0, 'ALTER TABLE users DROP COLUMN theme', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'home_layout');
SET @s = IF(@c > 0, 'ALTER TABLE users DROP COLUMN home_layout', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

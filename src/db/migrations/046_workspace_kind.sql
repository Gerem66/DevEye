-- Les espaces personnels deviennent de vraies lignes de `workspaces`.
--
-- Jusqu'ici l'espace personnel était virtuel (id 0 côté client, `workspace_id`
-- NULL en base, features portées par `users.features`). Après cette migration,
-- tout espace est une ligne et l'id 0 n'existe plus.
--
-- Le chiffrement n'est PAS touché : l'espace personnel appartient à son
-- propriétaire et continue de résoudre la DEK de cet utilisateur.
--
-- Ajouts de colonnes via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).

-- 1. `workspace_members.roles` part d'abord : `JSON NOT NULL` sans défaut, elle
--    ferait échouer l'insertion des adhésions personnelles (étape 6). Elle n'a
--    jamais contenu que `["owner"]`, la propriété passe sur `owner_user_id`.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members' AND COLUMN_NAME = 'roles');
SET @s = IF(@c > 0, 'ALTER TABLE workspace_members DROP COLUMN roles', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Les nouvelles colonnes de `workspaces`.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 'kind');
SET @s = IF(@c = 0,
    "ALTER TABLE workspaces ADD COLUMN kind ENUM('personal','shared') NOT NULL DEFAULT 'shared' AFTER id",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 'owner_user_id');
SET @s = IF(@c = 0,
    'ALTER TABLE workspaces ADD COLUMN owner_user_id INT NULL AFTER logo',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Le thème et la disposition d'accueil appartiennent à l'espace, pas au compte :
-- chaque espace a sa propre apparence. MEDIUMTEXT reprend le choix fait pour
-- `users.theme` (data URLs de fond d'écran en base64).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 'theme');
SET @s = IF(@c = 0,
    'ALTER TABLE workspaces ADD COLUMN theme MEDIUMTEXT NULL DEFAULT NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 'home_layout');
SET @s = IF(@c = 0,
    'ALTER TABLE workspaces ADD COLUMN home_layout MEDIUMTEXT NULL DEFAULT NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Propriétaire des espaces partagés existants : le membre le plus ancien,
--    c'est-à-dire son créateur (`workspace.add` ajoutait son auteur aussitôt).
UPDATE workspaces w
SET w.owner_user_id = (
    SELECT m.user_id FROM workspace_members m
    WHERE m.workspace_id = w.id ORDER BY m.date ASC, m.id ASC LIMIT 1
)
WHERE w.owner_user_id IS NULL;

-- 4. Un espace sans aucun membre n'est atteignable par personne et resterait
--    sans propriétaire, bloquant le NOT NULL de l'étape 7 : on le supprime.
DELETE FROM workspaces WHERE owner_user_id IS NULL;

-- 5. Un espace personnel par compte, reprenant ce que l'utilisateur portait :
--    ses features, son thème et sa disposition d'accueil.
INSERT INTO workspaces (kind, name, logo, owner_user_id, features, theme, home_layout, created)
SELECT 'personal', u.username, 'default-workspace.png', u.id, u.features, u.theme, u.home_layout, u.created
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM workspaces w WHERE w.kind = 'personal' AND w.owner_user_id = u.id
);

-- 6. Le propriétaire est membre de son espace personnel (invariant : tout accès
--    passe par `workspace_members`, sans exception pour le personnel).
INSERT INTO workspace_members (user_id, workspace_id)
SELECT w.owner_user_id, w.id
FROM workspaces w
WHERE w.kind = 'personal'
  AND NOT EXISTS (
      SELECT 1 FROM workspace_members m
      WHERE m.workspace_id = w.id AND m.user_id = w.owner_user_id
  );

-- 7. Le propriétaire devient obligatoire. Supprimer le compte emporte ses
--    espaces (et, par cascade FK, leur contenu).
ALTER TABLE workspaces MODIFY COLUMN owner_user_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces'
            AND CONSTRAINT_NAME = 'fk_workspace_owner');
SET @s = IF(@c = 0,
    'ALTER TABLE workspaces ADD CONSTRAINT fk_workspace_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces'
            AND INDEX_NAME = 'idx_workspaces_owner');
SET @s = IF(@c = 0,
    'ALTER TABLE workspaces ADD KEY idx_workspaces_owner (owner_user_id, kind)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 8. Colonnes mortes de `workspaces` : `password_hash` n'a jamais servi (le
--    déverrouillage passe par le compte) et `re_auth_interval` n'était lu par
--    aucun code (la fenêtre utilisée est `users.re_auth_interval`).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 'password_hash');
SET @s = IF(@c > 0, 'ALTER TABLE workspaces DROP COLUMN password_hash', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 're_auth_interval');
SET @s = IF(@c > 0, 'ALTER TABLE workspaces DROP COLUMN re_auth_interval', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

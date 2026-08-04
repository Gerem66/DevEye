-- Les espaces personnels deviennent de vraies lignes de `workspaces`.
--
-- Jusqu'ici l'espace personnel était virtuel : exposé au client sous l'id 0,
-- absent de la table, sa liste de features portée par `users.features` et ses
-- données rangées avec `workspace_id = NULL`. Résultat, chaque feature devait
-- traduire 0 ↔ NULL à la main (`toDbWorkspaceId`/`rowInWorkspace`, dupliqué dans
-- trois fichiers) et aucune requête ne filtrait réellement par espace.
--
-- Après cette migration, tout espace est une ligne, `workspace_id` est un entier
-- ordinaire, et l'id 0 n'existe plus nulle part.
--
-- IMPORTANT — le chiffrement n'est PAS touché : l'espace personnel appartient à
-- son propriétaire et continue de résoudre la DEK de cet utilisateur. Aucun blob
-- n'est re-chiffré ici, ni dans les migrations suivantes.
--
-- Toutes les additions de colonnes passent par INFORMATION_SCHEMA + SQL
-- dynamique et jamais par `ADD COLUMN IF NOT EXISTS` : cette clause (extension
-- MariaDB) a déjà fait tomber la production au démarrage, cf. 038.

-- 1. `workspace_members.roles` disparaît d'abord : la colonne est `JSON NOT NULL`
--    sans valeur par défaut, donc l'insertion des adhésions personnelles
--    (étape 6) échouerait tant qu'elle existe. Elle n'a jamais contenu autre
--    chose que `["owner"]`, et la propriété est désormais portée par
--    `workspaces.owner_user_id` ; les vrais rôles auront leur propre table.
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

-- 3. Propriétaire des espaces partagés existants : le membre le plus ancien.
--    C'est celui qui l'a créé — `workspace.add` ajoutait son auteur aussitôt.
UPDATE workspaces w
SET w.owner_user_id = (
    SELECT m.user_id FROM workspace_members m
    WHERE m.workspace_id = w.id ORDER BY m.date ASC, m.id ASC LIMIT 1
)
WHERE w.owner_user_id IS NULL;

-- 4. Un espace sans aucun membre n'est atteignable par personne (aucune UI ne
--    peut le produire aujourd'hui ; `findAccessibleByUser` passe par
--    `workspace_members`). Il resterait sans propriétaire et bloquerait le
--    NOT NULL de l'étape 7 : on le supprime. Vérifié à 0 avant migration.
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

-- 8. Colonnes mortes de `workspaces` : jamais lues nulle part.
--    `password_hash` n'a jamais servi (le déverrouillage passe par le compte) et
--    `re_auth_interval` était exposé au client sans qu'aucun code ne le lise —
--    la fenêtre de re-validation réellement utilisée est `users.re_auth_interval`.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 'password_hash');
SET @s = IF(@c > 0, 'ALTER TABLE workspaces DROP COLUMN password_hash', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND COLUMN_NAME = 're_auth_interval');
SET @s = IF(@c > 0, 'ALTER TABLE workspaces DROP COLUMN re_auth_interval', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

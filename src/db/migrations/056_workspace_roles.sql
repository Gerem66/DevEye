-- Roles d'espace : un role porte les droits, un membre porte un role.
--
-- La FK est `ON DELETE SET NULL` et surtout PAS `RESTRICT` : un RESTRICT entre
-- `workspace_members` et `workspace_roles` peut bloquer un `DELETE FROM
-- workspaces` selon l'ordre, non garanti par MySQL, de la cascade. Le refus de
-- supprimer un role encore porte est applique par le handler.

CREATE TABLE IF NOT EXISTS workspace_roles (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT          NOT NULL,
    name         VARCHAR(64)  NOT NULL,
    color        CHAR(7)      NOT NULL DEFAULT '#22d3ee',
    -- Ordre d'affichage seul : aucune hierarchie implicite entre roles.
    position     INT          NOT NULL DEFAULT 0,
    capabilities JSON         NOT NULL,
    features     JSON         NOT NULL,
    is_default   TINYINT      NOT NULL DEFAULT 0,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_workspace_roles_ws (workspace_id, position),
    CONSTRAINT fk_role_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members' AND COLUMN_NAME = 'role_id');
SET @s = IF(@c = 0, 'ALTER TABLE workspace_members ADD COLUMN role_id INT NULL AFTER workspace_id', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members'
            AND CONSTRAINT_NAME = 'fk_member_role');
SET @s = IF(@c = 0,
    'ALTER TABLE workspace_members ADD CONSTRAINT fk_member_role FOREIGN KEY (role_id) REFERENCES workspace_roles(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Un role « Membre » par espace partage existant, reproduisant le comportement
-- d'avant : ecriture sur toutes les features, aucune administration.
INSERT INTO workspace_roles (workspace_id, name, color, position, capabilities, features, is_default)
SELECT w.id, 'Membre', '#22d3ee', 0, CAST('[]' AS JSON),
       CAST('[{"feature":"devices","access":"read"},
              {"feature":"monitoring","access":"write"},
              {"feature":"weather","access":"write"},
              {"feature":"password","access":"write"},
              {"feature":"notes","access":"write"},
              {"feature":"cloudsync","access":"write"},
              {"feature":"uptime","access":"write"},
              {"feature":"mail","access":"write"}]' AS JSON),
       1
FROM workspaces w
WHERE w.kind = 'shared'
  AND NOT EXISTS (SELECT 1 FROM workspace_roles r WHERE r.workspace_id = w.id);

-- Les membres non proprietaires heritent de ce role. Le proprietaire n'en a
-- jamais besoin : il passe outre toute verification, et lui en donner un
-- laisserait croire qu'on peut le lui retirer.
UPDATE workspace_members m
JOIN workspaces w ON w.id = m.workspace_id
JOIN workspace_roles r ON r.workspace_id = w.id AND r.is_default = 1
SET m.role_id = r.id
WHERE m.role_id IS NULL
  AND w.kind = 'shared'
  AND m.user_id <> w.owner_user_id;

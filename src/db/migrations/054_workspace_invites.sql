-- Invitations a rejoindre un espace, par lien. Calque sur `device_link_codes` :
-- jeton, expiration facultative, revocation, compteur d'usages. Le jeton est
-- cryptographiquement aleatoire et long (il se copie-colle et ouvre l'acces a
-- des donnees). `uses` est incremente par la requete qui valide le jeton, pour
-- qu'une double acceptation simultanee ne passe pas deux fois.

CREATE TABLE IF NOT EXISTS workspace_invites (
    token        CHAR(43)    PRIMARY KEY,
    workspace_id INT         NOT NULL,
    -- Emetteur : sert a l'attribution et a l'audit, jamais au controle d'acces.
    created_by   INT         NOT NULL,
    -- NULL = n'expire jamais (comme les codes de liaison, cf. 021).
    expires_at   BIGINT      NULL,
    -- NULL = usages illimites.
    max_uses     INT         NULL,
    uses         INT         NOT NULL DEFAULT 0,
    revoked_at   BIGINT      NULL,
    created      BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_workspace_invites_ws (workspace_id),
    CONSTRAINT fk_invite_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_invite_author FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Un compte ne peut etre membre qu'une fois du meme espace : la contrainte
-- manquait, accepter deux fois une invitation aurait cree une seconde ligne.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members'
            AND INDEX_NAME = 'uniq_workspace_member');
SET @s = IF(@c = 0,
    'ALTER TABLE workspace_members ADD UNIQUE KEY uniq_workspace_member (workspace_id, user_id)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

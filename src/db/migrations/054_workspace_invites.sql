-- Invitations a rejoindre un espace, par lien.
--
-- Calque sur `device_link_codes`, le mecanisme d'invitation deja eprouve du
-- projet : un jeton, une expiration facultative, une revocation, un compteur
-- d'usages. Deux differences assumees :
--
--  - le jeton est cryptographiquement aleatoire et bien plus long qu'un code de
--    liaison. Un code d'appairage se tape a la main sur une machine (d'ou ses 8
--    caracteres lisibles) ; un lien d'invitation se copie-colle, et il ouvre
--    l'acces a des donnees, pas a l'enrolement d'un agent en attente
--    d'approbation.
--
--  - `max_uses` NULL = illimite, sinon le lien cesse d'etre valable une fois le
--    compte atteint. `uses` est incremente par la meme requete qui valide le
--    jeton, ce qui evite qu'une double acceptation simultanee passe deux fois.

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

-- Un compte ne peut etre membre qu'une fois du meme espace. La contrainte
-- manquait : jusqu'ici rien n'empechait deux lignes identiques, et accepter deux
-- fois une invitation en aurait cree une seconde.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members'
            AND INDEX_NAME = 'uniq_workspace_member');
SET @s = IF(@c = 0,
    'ALTER TABLE workspace_members ADD UNIQUE KEY uniq_workspace_member (workspace_id, user_id)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

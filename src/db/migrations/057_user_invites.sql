-- Invitations a creer un compte DevEye, emises par un administrateur :
-- `POST /api/auth/register` exige un jeton valide. Meme mecanique que
-- `workspace_invites`, avec `email` (verrouille l'invitation sur une adresse)
-- et `workspace_id` (fait rejoindre un espace des la creation du compte).

CREATE TABLE IF NOT EXISTS user_invites (
    token        CHAR(43)     PRIMARY KEY,
    created_by   INT          NOT NULL,
    -- NULL = ouverte a n'importe quelle adresse.
    email        VARCHAR(320) NULL,
    -- NULL = le compte n'a que son espace personnel a sa creation.
    workspace_id INT          NULL,
    -- NULL = n'expire jamais.
    expires_at   BIGINT       NULL,
    -- NULL = usages illimites.
    max_uses     INT          NULL,
    uses         INT          NOT NULL DEFAULT 0,
    revoked_at   BIGINT       NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_user_invites_author (created_by),
    CONSTRAINT fk_user_invite_author FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    -- L'espace disparait ? L'invitation reste valable, elle ne fera plus
    -- rejoindre que l'espace personnel.
    CONSTRAINT fk_user_invite_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

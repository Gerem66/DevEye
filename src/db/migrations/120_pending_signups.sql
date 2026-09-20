-- Inscriptions en attente de validation par mail. Aucun compte n'existe avant
-- la derniere etape. Des jetons, seul le condense SHA-256 est garde.
CREATE TABLE IF NOT EXISTS pending_signups (
    id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email        VARCHAR(320) NOT NULL,
    username     VARCHAR(64)  NOT NULL,
    token_hash   CHAR(64)     NOT NULL,
    watch_hash   CHAR(64)     NOT NULL,
    plan         VARCHAR(64)  NULL,
    opened_at    BIGINT       NULL,
    completed_at BIGINT       NULL,
    expires_at   BIGINT       NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_pending_signup_email (email),
    UNIQUE KEY uniq_pending_signup_token (token_hash),
    UNIQUE KEY uniq_pending_signup_watch (watch_hash),
    KEY idx_pending_signup_username (username),
    KEY idx_pending_signup_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

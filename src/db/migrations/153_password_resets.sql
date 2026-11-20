-- Les demandes de réinitialisation d'un mot de passe oublié, une par compte :
-- la nouvelle remplace l'ancienne. Du jeton envoyé par mail, seul le condensé
-- SHA-256 est gardé, et la ligne disparaît dès qu'il a servi.
CREATE TABLE IF NOT EXISTS password_resets (
    id         INT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    INT      NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at BIGINT   NOT NULL,
    created    BIGINT   NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_password_reset_user (user_id),
    UNIQUE KEY uniq_password_reset_token (token_hash),
    KEY idx_password_reset_expires (expires_at),
    CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

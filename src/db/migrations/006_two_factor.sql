-- TOTP two-factor authentication. The secret is encrypted at rest (zero-knowledge).
-- Recovery codes are stored as SHA-256 hashes; raw codes are shown once.

CREATE TABLE IF NOT EXISTS user_2fa (
    user_id      INT      PRIMARY KEY,
    secret_enc   TEXT     NOT NULL,
    enabled      TINYINT  NOT NULL DEFAULT 0,
    created      BIGINT   NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    confirmed_at BIGINT   NULL,
    CONSTRAINT fk_2fa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_2fa_backup_codes (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    user_id   INT      NOT NULL,
    code_hash CHAR(64) NOT NULL,
    used_at   BIGINT   NULL,
    created   BIGINT   NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_2fa_backup_user (user_id),
    CONSTRAINT fk_2fa_backup_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

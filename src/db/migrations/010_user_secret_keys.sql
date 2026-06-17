-- Per-user envelope encryption key (DEK).
--
-- Every user owns a random Data Encryption Key that encrypts all their feature
-- data (passwords, etc.). The DEK never changes; only its *wrapping* does:
--   wrap_mode = 'server'   → DEK encrypted by the server key (feature OFF).
--   wrap_mode = 'password' → DEK encrypted by a key derived from the user's
--                            password via Argon2id with `kdf_salt` (feature ON).
--
-- An optional recovery code (chosen at activation) wraps a second copy of the
-- DEK in `recovery_wrapped`/`recovery_salt` so a forgotten password is
-- survivable. Toggling the feature or changing the password only re-wraps the
-- DEK; encrypted content is never rewritten.

CREATE TABLE IF NOT EXISTS user_secret_keys (
    user_id          INT          PRIMARY KEY,
    dek_wrapped      TEXT         NOT NULL,
    wrap_mode        ENUM('server', 'password') NOT NULL DEFAULT 'server',
    kdf_salt         VARBINARY(32) NULL,
    recovery_wrapped TEXT         NULL,
    recovery_salt    VARBINARY(32) NULL,
    version          INT          NOT NULL DEFAULT 1,
    created          BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated          BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    CONSTRAINT fk_secret_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

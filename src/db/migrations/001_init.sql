-- DevEye initial schema (MySQL 8)
-- Conventions: snake_case, integer PKs (AUTO_INCREMENT), bigint epoch-seconds for time fields.

CREATE TABLE IF NOT EXISTS users (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    email             VARCHAR(320) NOT NULL UNIQUE,
    username          VARCHAR(64)  NOT NULL UNIQUE,
    password_hash     TEXT         NOT NULL,
    avatar            VARCHAR(256) NOT NULL DEFAULT 'default-user.png',
    settings          JSON         NOT NULL,
    default_workspace INT          NOT NULL DEFAULT 0,
    default_feature   VARCHAR(64)  NOT NULL DEFAULT 'profile',
    re_auth_interval  INT          NULL,
    last_login        BIGINT       NOT NULL DEFAULT 0,
    created           BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP())
);

CREATE TABLE IF NOT EXISTS workspaces (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    name             VARCHAR(128) NOT NULL,
    logo             VARCHAR(256) NOT NULL DEFAULT 'default-workspace.png',
    features         JSON         NOT NULL,
    password_hash    TEXT         NULL,
    re_auth_interval INT          NULL,
    created          BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP())
);

CREATE TABLE IF NOT EXISTS workspace_members (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT    NOT NULL,
    workspace_id INT    NOT NULL,
    roles        JSON   NOT NULL,
    date         BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_member (user_id, workspace_id),
    KEY idx_workspace_members_user (user_id),
    KEY idx_workspace_members_workspace (workspace_id),
    CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_member_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS passwords (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT    NOT NULL,
    workspace_id INT    NULL,
    content      TEXT   NOT NULL,
    date         BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_passwords_user (user_id),
    KEY idx_passwords_workspace (workspace_id),
    CONSTRAINT fk_password_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_password_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS logs (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    uid         INT          NOT NULL DEFAULT 0,
    ip          VARCHAR(64)  NOT NULL DEFAULT '',
    level       INT          NOT NULL DEFAULT 0,
    type        VARCHAR(64)  NOT NULL DEFAULT '',
    description TEXT         NOT NULL,
    date        BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_logs_uid (uid),
    KEY idx_logs_date (date)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti         CHAR(36) PRIMARY KEY,
    user_id     INT      NOT NULL,
    session_id  CHAR(36) NOT NULL,
    token_hash  CHAR(64) NOT NULL,
    expires_at  BIGINT   NOT NULL,
    created_at  BIGINT   NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    revoked_at  BIGINT   NULL,
    KEY idx_refresh_tokens_user (user_id),
    KEY idx_refresh_tokens_session (session_id),
    CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


-- Monitored machines (the Rust agent) and their short-lived link codes.

CREATE TABLE IF NOT EXISTS devices (
    id          CHAR(36)     PRIMARY KEY,
    owner_id    INT          NOT NULL,
    name        VARCHAR(128) NOT NULL,
    fingerprint VARCHAR(128) NOT NULL,
    platform    VARCHAR(32)  NOT NULL DEFAULT 'linux',
    status      VARCHAR(16)  NOT NULL DEFAULT 'pending',
    public_key  VARCHAR(256) NULL,
    -- SHA-256 of the device token; the raw token lives only on the agent.
    token_hash  CHAR(64)     NOT NULL,
    last_seen   BIGINT       NULL,
    created     BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_owner_fingerprint (owner_id, fingerprint),
    KEY idx_devices_owner (owner_id),
    KEY idx_devices_status (status),
    CONSTRAINT fk_device_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One-time codes a logged-in user generates to link a new machine.
CREATE TABLE IF NOT EXISTS device_link_codes (
    code       VARCHAR(32) PRIMARY KEY,
    user_id    INT         NOT NULL,
    expires_at BIGINT      NOT NULL,
    used_at    BIGINT      NULL,
    created    BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_link_codes_user (user_id),
    CONSTRAINT fk_linkcode_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

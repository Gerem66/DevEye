-- Per-user weather widget instances and optional encrypted provider API keys.

CREATE TABLE IF NOT EXISTS weather_locations (
    id        CHAR(36)     PRIMARY KEY,
    user_id   INT          NOT NULL,
    label     VARCHAR(120) NOT NULL,
    latitude  DOUBLE       NOT NULL,
    longitude DOUBLE       NOT NULL,
    format    VARCHAR(16)  NOT NULL DEFAULT 'current',
    days      INT          NOT NULL DEFAULT 7,
    provider  VARCHAR(32)  NOT NULL DEFAULT 'open-meteo',
    position  INT          NOT NULL DEFAULT 0,
    created   BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_weather_user (user_id),
    CONSTRAINT fk_weather_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weather_provider_keys (
    user_id  INT         NOT NULL,
    provider VARCHAR(32)  NOT NULL,
    key_enc  TEXT         NOT NULL,
    created  BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (user_id, provider),
    CONSTRAINT fk_weatherkey_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

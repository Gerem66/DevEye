-- Logs feature: enrich the audit log so entries are precisely interpretable and
-- filterable. The original table (001_init) had only `uid, ip, level, type,
-- description, date`. We add the dimensions the Logs feature filters on:
--
--   source   — origin channel: web | api | agent | system  ("Via API", etc.)
--   category — emitting feature/subsystem (auth, note, password, …)
--   metadata — optional structured context (JSON) attached by the emitter
--
-- and rename the vague `type` to `action` (the specific event key, e.g.
-- `login.failed`). The logs table was previously unused (no emitter wrote to it),
-- so there is no data to preserve — a clean schema migration, per project policy.
ALTER TABLE logs
    ADD COLUMN source   VARCHAR(16) NOT NULL DEFAULT 'system' AFTER ip,
    ADD COLUMN category VARCHAR(64) NOT NULL DEFAULT ''        AFTER source,
    ADD COLUMN metadata JSON        NULL                       AFTER description;

ALTER TABLE logs
    CHANGE COLUMN type action VARCHAR(64) NOT NULL DEFAULT '';

-- Indexes backing the feature's filter surface (user, channel, feature, action,
-- importance). `idx_logs_uid` / `idx_logs_date` already exist from 001_init.
CREATE INDEX idx_logs_source   ON logs (source);
CREATE INDEX idx_logs_category ON logs (category);
CREATE INDEX idx_logs_action   ON logs (action);
CREATE INDEX idx_logs_level    ON logs (level);

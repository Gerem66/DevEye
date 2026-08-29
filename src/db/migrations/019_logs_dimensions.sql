-- Logs: the dimensions the Logs feature filters on.
--   source   : origin channel: web | api | agent | system
--   category : emitting feature/subsystem (auth, note, password, ...)
--   metadata : optional structured context (JSON) attached by the emitter
-- `type` becomes `action` (the specific event key, e.g. `login.failed`).
-- Nothing had written to the table yet, so there is no data to preserve.
ALTER TABLE logs
    ADD COLUMN source   VARCHAR(16) NOT NULL DEFAULT 'system' AFTER ip,
    ADD COLUMN category VARCHAR(64) NOT NULL DEFAULT ''        AFTER source,
    ADD COLUMN metadata JSON        NULL                       AFTER description;

ALTER TABLE logs
    CHANGE COLUMN type action VARCHAR(64) NOT NULL DEFAULT '';

-- Indexes backing the filter surface. `idx_logs_uid` / `idx_logs_date` already exist.
CREATE INDEX idx_logs_source   ON logs (source);
CREATE INDEX idx_logs_category ON logs (category);
CREATE INDEX idx_logs_action   ON logs (action);
CREATE INDEX idx_logs_level    ON logs (level);

-- Personal workspace features.
-- The private/personal workspace is surfaced to clients as workspace id 0 and is
-- not stored as a row in `workspaces`. Its feature list lives on the owning user.
ALTER TABLE users
    ADD COLUMN features JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER settings;

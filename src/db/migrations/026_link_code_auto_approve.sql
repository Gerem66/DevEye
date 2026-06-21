-- Per-link-code auto-approval: a device enrolling with such a code is created
-- (or re-enrolled) directly as `active` instead of `pending`. Off by default —
-- manual approval stays the safe default.

ALTER TABLE device_link_codes
    ADD COLUMN auto_approve TINYINT NOT NULL DEFAULT 0;

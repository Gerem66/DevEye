-- Pinned snapshots: keep a process snapshot *and* its metric point past the
-- device's retention. The hourly retention sweep skips pinned rows; unpinning
-- lets them expire again. `pinned=1` is set on both tables for the same instant
-- (or range) so a saved moment stays fully consultable.

ALTER TABLE device_process_samples
    ADD COLUMN pinned TINYINT NOT NULL DEFAULT 0;

ALTER TABLE device_metrics
    ADD COLUMN pinned TINYINT NOT NULL DEFAULT 0;

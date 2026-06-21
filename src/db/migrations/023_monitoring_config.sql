-- Monitoring v3: two collection cadences + per-device config.
-- Disk I/O metrics (filled only by the heavier "snapshot" cycle), per-device
-- cadences / capture mode / process retention, and rename the process-sample
-- kind 'full' → 'all' to match the new capture vocabulary.

ALTER TABLE device_metrics
    ADD COLUMN disk_read_bytes  BIGINT NULL,
    ADD COLUMN disk_write_bytes BIGINT NULL;

ALTER TABLE devices
    ADD COLUMN metric_interval_seconds   INT NULL,
    ADD COLUMN snapshot_interval_seconds INT NULL,
    ADD COLUMN process_capture           ENUM('off','top','all') NULL,
    ADD COLUMN process_retention_days    INT NULL;

-- 'full' (everything) is now 'all'; widen the enum, migrate, then narrow it.
ALTER TABLE device_process_samples MODIFY kind ENUM('top','full','all') NOT NULL;
UPDATE device_process_samples SET kind = 'all' WHERE kind = 'full';
ALTER TABLE device_process_samples MODIFY kind ENUM('top','all') NOT NULL DEFAULT 'all';

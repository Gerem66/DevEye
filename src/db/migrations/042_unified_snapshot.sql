-- Unified collection cadence: one agent tick now produces one *instant* carrying
-- both the graph signals and the process list, under a single timestamp. The
-- separate "heavy snapshot" cadence disappears, so `snapshot_interval_seconds`
-- has no meaning anymore.
--
-- Process storage changes shape accordingly: at a one-minute cadence the old
-- one-row-per-process layout would cost ~120 MB/day/device (584 distinct program
-- names x 1440 samples). One gzipped JSON blob per instant costs ~7 MB/day for
-- the same data — and nothing ever aggregates processes by name across time,
-- every query (nearest, snapshotTimes, storage, delete, pin, prune) works on
-- `ts` alone. Process history restarts from scratch; metrics are untouched.

DROP TABLE IF EXISTS device_process_samples;

CREATE TABLE IF NOT EXISTS device_process_samples (
    device_id  CHAR(36)          NOT NULL,
    ts         BIGINT            NOT NULL,
    kind       ENUM('top','all') NOT NULL,
    -- Number of process entries inside `payload`, so counting never needs a decompress.
    proc_count INT UNSIGNED      NOT NULL,
    -- gzipped JSON array of ReportProcess (compressed by the server, node:zlib).
    payload    MEDIUMBLOB        NOT NULL,
    pinned     TINYINT           NOT NULL DEFAULT 0,
    -- One row per instant: the primary key doubles as the (device_id, ts) lookup index.
    PRIMARY KEY (device_id, ts),
    KEY idx_procsamples_pinned (device_id, pinned, ts),
    CONSTRAINT fk_procsamples_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

ALTER TABLE devices
    DROP COLUMN snapshot_interval_seconds;

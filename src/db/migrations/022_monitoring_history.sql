-- Monitoring v2: GPU metric, per-device retention, connectivity history and
-- process-sample history (for the timeline + "time travel" view).

ALTER TABLE device_metrics
    ADD COLUMN gpu_percent FLOAT NULL;

-- Per-device history retention (days). NULL → server default.
ALTER TABLE devices
    ADD COLUMN retention_days INT NULL;

-- Agent connectivity transitions (online/offline), to draw the uptime timeline.
CREATE TABLE IF NOT EXISTS device_presence (
    id        BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id CHAR(36) NOT NULL,
    ts        BIGINT   NOT NULL,
    online    TINYINT  NOT NULL,
    KEY idx_presence_device_ts (device_id, ts),
    CONSTRAINT fk_presence_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Point-in-time process lists. `kind='top'` (~20 heaviest) every cycle,
-- `kind='full'` (everything) hourly. One row per process per sample.
CREATE TABLE IF NOT EXISTS device_process_samples (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id   CHAR(36)            NOT NULL,
    ts          BIGINT              NOT NULL,
    kind        ENUM('top','full')  NOT NULL,
    name        VARCHAR(128)        NOT NULL,
    cpu_percent FLOAT               NOT NULL,
    mem_bytes   BIGINT              NOT NULL,
    KEY idx_procsamples_device_ts (device_id, ts),
    CONSTRAINT fk_procsamples_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

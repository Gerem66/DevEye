-- Time-series metric samples pushed by agents. `ts` is unix milliseconds.
-- Kept raw; querying buckets/downsamples on read. A retention job may prune old rows.

CREATE TABLE IF NOT EXISTS device_metrics (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id        CHAR(36) NOT NULL,
    ts               BIGINT   NOT NULL,
    cpu_percent      FLOAT    NOT NULL,
    mem_used_bytes   BIGINT   NOT NULL,
    mem_total_bytes  BIGINT   NOT NULL,
    disk_used_bytes  BIGINT   NOT NULL,
    disk_total_bytes BIGINT   NOT NULL,
    net_rx_bytes     BIGINT   NOT NULL,
    net_tx_bytes     BIGINT   NOT NULL,
    users_count      INT      NOT NULL,
    KEY idx_metrics_device_ts (device_id, ts),
    CONSTRAINT fk_metrics_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

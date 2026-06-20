-- Extended agent telemetry: richer health metrics in the time-series, plus a
-- latest-known health/security report stored per device.

ALTER TABLE device_metrics
    ADD COLUMN load_avg_1        FLOAT  NULL,
    ADD COLUMN cpu_temp_c        FLOAT  NULL,
    ADD COLUMN uptime_seconds    BIGINT NULL,
    ADD COLUMN process_count     INT    NULL,
    ADD COLUMN active_connections INT   NULL;

-- JSON-encoded latest DeviceReport (OS info, security posture, top processes).
ALTER TABLE devices
    ADD COLUMN report_json TEXT NULL;

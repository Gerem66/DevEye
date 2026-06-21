-- Battery telemetry (laptops). NULL when the machine has no battery.
ALTER TABLE device_metrics
    ADD COLUMN battery_percent  FLOAT   NULL,
    ADD COLUMN battery_charging TINYINT NULL;

-- The per-user "default feature" (opened at login) is gone: the homepage is
-- always the default view. `default_workspace` stays (still used).
ALTER TABLE users DROP COLUMN default_feature;

-- Weather: one "primary" location per user, shown in the topbar and the home
-- widget. Falls back to the first location when unset.
ALTER TABLE weather_locations ADD COLUMN is_primary TINYINT(1) NOT NULL DEFAULT 0;

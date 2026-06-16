-- Drop the now-removed "favorite feature" concept (a feature opened by default).
-- The homepage is always the default view now, so the per-user default feature
-- is obsolete. The default_workspace column is kept (still used).
ALTER TABLE users DROP COLUMN default_feature;

-- Weather: mark one location per user as the "primary" city, shown in the
-- topbar and the home widget. Falls back to the first location when unset.
ALTER TABLE weather_locations ADD COLUMN is_primary TINYINT(1) NOT NULL DEFAULT 0;

-- Per-user home dashboard layout (ordered tiles: features / devices / shortcuts).
-- JSON-serialised HomeLayout; MEDIUMTEXT mirrors the `theme` column's choice and
-- leaves ample room for the (small) tile list. Null until the user saves one.
ALTER TABLE users
    ADD COLUMN home_layout MEDIUMTEXT NULL DEFAULT NULL;

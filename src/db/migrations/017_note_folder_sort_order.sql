-- Folders are now manually orderable (move up/down) instead of being sorted by
-- name. `sort_order` is a clear column (the order isn't sensitive) holding the
-- folder's rank within its user; lower comes first. Existing folders are
-- backfilled to their current id order so nothing visibly reshuffles.
ALTER TABLE note_folders
    ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER content;

-- Seed each user's folders 0,1,2,… by id so the initial order matches the old
-- "ORDER BY id ASC" listing.
UPDATE note_folders nf
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id ASC) - 1 AS rn
    FROM note_folders
) ranked ON ranked.id = nf.id
SET nf.sort_order = ranked.rn;

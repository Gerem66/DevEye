-- Notes: "hidden" (session-wide reveal) becomes per-note "locked". A locked
-- note carries its own password, stored only as an argon2 hash in the clear
-- column `lock_hash`. This is an ACCESS gate, not a second encryption layer:
-- the body stays encrypted by the SecureStore exactly as before.
-- `lock_hash` NULL = open. Set = opening and deleting the note require it.
-- Old hidden notes become plain notes (no content lost), then `hidden` is dropped.
ALTER TABLE notes
    ADD COLUMN lock_hash VARCHAR(255) NULL AFTER pinned;

UPDATE notes SET hidden = 0 WHERE hidden = 1;

ALTER TABLE notes
    DROP COLUMN hidden;

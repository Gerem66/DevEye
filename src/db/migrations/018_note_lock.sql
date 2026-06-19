-- Notes refonte: "masquées" (session-wide reveal via account password) → per-note
-- "verrouillées" (locked). Each locked note carries its own dedicated password,
-- stored only as an argon2 hash in the clear column `lock_hash`. This is an
-- ACCESS gate, not a second encryption layer: the body stays encrypted by the
-- SecureStore exactly as before — the DB encryption is unchanged.
--
-- `lock_hash` NULL  → the note is not locked (open).
-- `lock_hash` set   → opening (read/edit) and deleting the note require its mdp.
--
-- Old hidden notes are converted to plain (unlocked) notes: no content is lost,
-- the user re-locks the ones that matter. Then the now-unused `hidden` flag is
-- dropped (no backwards-compat shim — schema migration, per project policy).
ALTER TABLE notes
    ADD COLUMN lock_hash VARCHAR(255) NULL AFTER pinned;

UPDATE notes SET hidden = 0 WHERE hidden = 1;

ALTER TABLE notes
    DROP COLUMN hidden;

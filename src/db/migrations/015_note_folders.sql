-- Folders for the Notes feature: first-class, server-persisted buckets so empty
-- folders survive reloads and can be renamed/deleted independently of notes.
--
-- Like notes, a folder's name is sensitive and lives encrypted in `content`
-- (a `{ name }` payload) — the server stays zero-knowledge about folder names.
-- `workspace_id` NULL is the caller's personal workspace (id 0 client-side).
CREATE TABLE IF NOT EXISTS note_folders (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT     NOT NULL,
    workspace_id INT     NULL,
    content      TEXT    NOT NULL,
    created      BIGINT  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_note_folders_user (user_id),
    KEY idx_note_folders_workspace (workspace_id),
    CONSTRAINT fk_note_folder_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_note_folder_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Notes now reference a folder by stable id (clear column, like pinned/hidden)
-- rather than carrying the folder name in their encrypted body. NULL = no
-- folder ("Sans dossier"). ON DELETE SET NULL: deleting a folder un-files its
-- notes rather than destroying them.
ALTER TABLE notes
    ADD COLUMN folder_id INT NULL AFTER workspace_id,
    ADD KEY idx_notes_folder (folder_id),
    ADD CONSTRAINT fk_note_folder FOREIGN KEY (folder_id) REFERENCES note_folders(id) ON DELETE SET NULL;

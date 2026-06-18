-- Notes feature: per-user, workspace-scoped notes with an encrypted body.
--
-- Mirrors `passwords`: `content` is the encrypted payload (title + folder +
-- blocks) so the server stays zero-knowledge about the note body. The columns
-- kept in clear (`pinned`, `hidden`, `updated`) are non-sensitive metadata the
-- server needs to list/sort/gate without decrypting. `workspace_id` NULL is the
-- caller's personal workspace (id 0 client-side), matching the passwords model.
CREATE TABLE IF NOT EXISTS notes (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT     NOT NULL,
    workspace_id INT     NULL,
    content      TEXT    NOT NULL,
    pinned       TINYINT NOT NULL DEFAULT 0,
    -- Hidden notes require the session to be unlocked (master password / cached
    -- DEK) before their body is returned. No per-note password by design.
    hidden       TINYINT NOT NULL DEFAULT 0,
    updated      BIGINT  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    created      BIGINT  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_notes_user (user_id),
    KEY idx_notes_workspace (workspace_id),
    CONSTRAINT fk_note_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_note_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

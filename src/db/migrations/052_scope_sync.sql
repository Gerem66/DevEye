-- CloudSync passe au scope espace : `sync_shares.workspace_id` existait (avec sa
-- FK) sans jamais etre renseigne. Backfill vers l'espace personnel, puis NOT NULL.
-- Les autres tables `sync_*` passent par `share_id`. Les blobs ne sont pas
-- touches : la BMK est independante des DEK utilisateur (cf. SECURITY_MODEL.md).

UPDATE sync_shares s
JOIN users u ON u.id = s.user_id
SET s.workspace_id = u.personal_workspace_id
WHERE s.workspace_id IS NULL;

ALTER TABLE sync_shares MODIFY COLUMN workspace_id INT NOT NULL;

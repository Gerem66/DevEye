-- Ordre des notes entièrement défini par l'utilisateur (glisser-déposer).
--
-- `sort_order` est le rang d'une note DANS SON DOSSIER (colonne claire, comme
-- `note_folders.sort_order`) : plus petit = affiché en premier. Rien ne le
-- change automatiquement — seuls `note.reorder` et l'ajout d'une note (qui
-- prend le rang suivant, donc la fin) y touchent.
ALTER TABLE notes
    ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER folder_id;

-- Rang initial = l'ordre d'affichage précédent (épinglées d'abord, puis les
-- plus récemment modifiées), numéroté par (utilisateur, workspace, dossier)
-- pour que rien ne bouge visiblement à la migration.
UPDATE notes n
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, workspace_id, folder_id
               ORDER BY pinned DESC, updated DESC, id DESC
           ) - 1 AS rn
    FROM notes
) ranked ON ranked.id = n.id
SET n.sort_order = ranked.rn;

-- L'épinglage disparaît : il n'a plus de sens avec un ordre libre, une note
-- « en haut » se traîne simplement en première position.
ALTER TABLE notes
    DROP COLUMN pinned;

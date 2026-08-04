-- `workspace_id` devient la vraie clé de cloisonnement pour les notes, leurs
-- dossiers et les mots de passe.
--
-- La colonne existait déjà mais était nullable et — surtout — n'apparaissait
-- dans AUCUNE clause WHERE : les handlers listaient par `user_id` puis
-- filtraient en JS. Ici NULL (« espace personnel ») devient l'id réel de
-- l'espace personnel du propriétaire, et la colonne passe NOT NULL. Les repos
-- filtrent ensuite par `workspace_id` seul.
--
-- `user_id` est CONSERVÉ : dans un espace partagé il dira qui a créé la ligne
-- (attribution, et plus tard filtrage « mes éléments »). Il cesse simplement
-- d'être la frontière d'accès.

-- 1. Backfill : NULL → l'espace personnel du propriétaire de la ligne.
UPDATE passwords p
JOIN users u ON u.id = p.user_id
SET p.workspace_id = u.personal_workspace_id
WHERE p.workspace_id IS NULL;

UPDATE notes n
JOIN users u ON u.id = n.user_id
SET n.workspace_id = u.personal_workspace_id
WHERE n.workspace_id IS NULL;

UPDATE note_folders f
JOIN users u ON u.id = f.user_id
SET f.workspace_id = u.personal_workspace_id
WHERE f.workspace_id IS NULL;

-- 2. La colonne devient obligatoire, et la FK garantit qu'aucune donnée ne
--    survit à la suppression de son espace.
ALTER TABLE passwords MODIFY COLUMN workspace_id INT NOT NULL;
ALTER TABLE notes MODIFY COLUMN workspace_id INT NOT NULL;
ALTER TABLE note_folders MODIFY COLUMN workspace_id INT NOT NULL;

-- 3. Les rangs étaient numérotés par utilisateur ; ils doivent l'être par espace,
--    sinon deux membres d'un même espace partagé produiraient des rangs qui se
--    télescopent. Motif idempotent (renumérotation à partir de l'ordre courant) :
--    rejouer la migration ne change rien.
UPDATE note_folders f
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY sort_order ASC, id ASC) - 1 AS rn
    FROM note_folders
) r ON r.id = f.id
SET f.sort_order = r.rn;

-- `folder_id IS NULL` forme une partition unique en MySQL, ce qui est exactement
-- voulu ici : toutes les notes non classées d'un espace sont une seule liste.
UPDATE notes n
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id, folder_id ORDER BY sort_order ASC, id ASC) - 1 AS rn
    FROM notes
) r ON r.id = n.id
SET n.sort_order = r.rn;

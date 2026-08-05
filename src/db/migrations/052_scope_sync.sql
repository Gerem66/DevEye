-- CloudSync passe au scope espace.
--
-- `sync_shares.workspace_id` existait deja (avec sa FK) mais n'a jamais ete
-- renseigne ni lu : `syncShares.create` ne l'acceptait meme pas en parametre.
-- On le backfill vers l'espace personnel du proprietaire, puis NOT NULL.
--
-- Aucune autre table `sync_*` n'a besoin de colonne : fichiers, versions,
-- sessions, evenements, exclusions et appareils rattaches passent tous par
-- `share_id`, donc cloisonner le partage cloisonne l'arbre entier.
--
-- Les blobs ne sont pas touches : CloudSync chiffre avec une BMK unique wrappee
-- par la cle serveur (cf. SECURITY_MODEL.md), independante des DEK utilisateur —
-- ce changement de rattachement ne l'affecte donc pas du tout.

UPDATE sync_shares s
JOIN users u ON u.id = s.user_id
SET s.workspace_id = u.personal_workspace_id
WHERE s.workspace_id IS NULL;

ALTER TABLE sync_shares MODIFY COLUMN workspace_id INT NOT NULL;

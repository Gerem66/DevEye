-- Notes : le verrou par note (mot de passe dédié, `lock_hash`) disparaît au
-- profit d'un simple drapeau « privée ».
--
-- Nouveau modèle : la feature Notes s'ouvre SANS mot de passe. Le corps d'une
-- note ordinaire est chiffré par la DEK ouverte (cf. 033), celui d'une note
-- `is_private` par la DEK emballée par le mot de passe — c'est le chiffrement
-- lui-même qui protège, plus un contrôle d'accès par-dessus.
ALTER TABLE notes
    ADD COLUMN is_private TINYINT NOT NULL DEFAULT 0 AFTER pinned;

-- Tout l'existant a été écrit avec la DEK principale : ces notes sont donc
-- privées par construction. Les rendre publiques exigerait de les re-chiffrer,
-- ce qu'une migration SQL ne peut pas faire (il faudrait le mot de passe en
-- clair) ; l'utilisateur bascule celles qu'il veut depuis l'éditeur.
UPDATE notes SET is_private = 1;

ALTER TABLE notes
    DROP COLUMN lock_hash;

-- Les noms de dossiers passent eux aussi sur la DEK ouverte (la feature doit
-- pouvoir afficher l'arborescence sans mot de passe). Même impossibilité de
-- re-chiffrement : on vide le nom plutôt que de laisser un blob illisible. Les
-- dossiers et le classement des notes sont conservés — il n'y a qu'à renommer.
UPDATE note_folders SET content = '';

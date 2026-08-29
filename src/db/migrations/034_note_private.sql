-- Notes : le verrou par note (`lock_hash`) disparaît au profit d'un drapeau
-- « privée ». Le corps d'une note ordinaire est chiffré par la DEK ouverte
-- (cf. 033), celui d'une note `is_private` par la DEK emballée par le mot de
-- passe : c'est le chiffrement lui-même qui protège.
ALTER TABLE notes
    ADD COLUMN is_private TINYINT NOT NULL DEFAULT 0 AFTER pinned;

-- Tout l'existant a été écrit avec la DEK principale : ces notes sont privées
-- par construction. Les rendre publiques exigerait de les re-chiffrer, ce qu'une
-- migration SQL ne peut pas faire (il faudrait le mot de passe en clair).
UPDATE notes SET is_private = 1;

ALTER TABLE notes
    DROP COLUMN lock_hash;

-- Les noms de dossiers passent sur la DEK ouverte (l'arborescence s'affiche sans
-- mot de passe). Même impossibilité de re-chiffrement : le nom est vidé plutôt
-- que laissé en blob illisible, les dossiers et le classement sont conservés.
UPDATE note_folders SET content = '';

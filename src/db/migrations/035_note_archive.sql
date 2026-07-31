-- Archivage des notes : « supprimer » ne détruit plus rien.
--
-- `archived_at` NULL  → note active (la liste principale).
-- `archived_at` set   → note archivée, sortie de la liste, restaurable.
--
-- La destruction définitive (`note.delete`) n'est acceptée que sur une ligne
-- déjà archivée : impossible de perdre une note en un seul geste. Colonne claire
-- (une date d'archivage n'est pas sensible) pour filtrer sans déchiffrer.
ALTER TABLE notes
    ADD COLUMN archived_at BIGINT NULL AFTER is_private,
    ADD KEY idx_notes_archived (user_id, archived_at);

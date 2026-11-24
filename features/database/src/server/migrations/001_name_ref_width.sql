-- Le condense du nom d'une base passe sous cle (keys.ref) : 32 caracteres au
-- lieu de 16. L'etape de donnees 001-keyed-refs recalcule ensuite chaque ligne.
--
-- Rejouable : la colonne garde le type qu'on lui redonne.
ALTER TABLE database_connections MODIFY name_ref CHAR(32) NOT NULL;

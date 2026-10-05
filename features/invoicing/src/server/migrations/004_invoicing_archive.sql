-- L'archivage d'un document émis : il sort des listes et de l'accueil, et reste
-- dans les chiffres, qui ne lisent pas cette colonne. Un brouillon ne s'archive
-- pas, il se supprime.
--
-- Rejouable : sonde d'existence, puis ajout sous garde. MySQL ne connaît pas
-- ADD COLUMN IF NOT EXISTS.

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ft_invoicing_docs'
      AND COLUMN_NAME = 'archived');

SET @s = IF(@has_column = 0,
    'ALTER TABLE ft_invoicing_docs ADD COLUMN archived TINYINT NOT NULL DEFAULT 0 AFTER status',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

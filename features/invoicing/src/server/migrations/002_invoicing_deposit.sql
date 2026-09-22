-- Le drapeau d'acompte d'une facture. Une colonne plutôt qu'une déduction :
-- avant que la facture de solde existe, rien ne distinguerait un acompte d'une
-- facture ordinaire née du même devis.
--
-- Elle arrive ici et non dans la 001 parce que celle-ci était déjà appliquée
-- quand le besoin est apparu. Une migration jouée ne se retouche pas : la table
-- `_migrations` ne rejoue jamais un nom déjà vu, donc l'édition aurait été un
-- silence, et la base aurait divergé du fichier sans que rien ne le signale.
--
-- Rejouable : sonde d'existence, puis ajout sous garde. MySQL ne connaît pas
-- ADD COLUMN IF NOT EXISTS.

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ft_invoicing_docs'
      AND COLUMN_NAME = 'is_deposit');

SET @s = IF(@has_column = 0,
    'ALTER TABLE ft_invoicing_docs ADD COLUMN is_deposit TINYINT NOT NULL DEFAULT 0 AFTER parent_doc_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

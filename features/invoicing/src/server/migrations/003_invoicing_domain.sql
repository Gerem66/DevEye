-- Le domaine sous lequel partent les liens des documents, choisi parmi ceux que
-- l'espace a déclarés et vérifiés pour la facturation. NULL : l'adresse de
-- DevEye. Pas de clé étrangère vers feature_domains : le retrait d'un domaine
-- passe par le module (`onRemoved`), qui remet la colonne à NULL.
--
-- Rejouable : sonde d'existence, puis ajout sous garde. MySQL ne connaît pas
-- ADD COLUMN IF NOT EXISTS.

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ft_invoicing_settings'
      AND COLUMN_NAME = 'domain_id');

SET @s = IF(@has_column = 0,
    'ALTER TABLE ft_invoicing_settings ADD COLUMN domain_id INT NULL AFTER mail_sender_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

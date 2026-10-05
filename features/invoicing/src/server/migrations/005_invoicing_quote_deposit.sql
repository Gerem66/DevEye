-- La part d'acompte qu'un devis annonce, et celle que l'espace propose par
-- défaut. En points de base (3000 vaut 30 pour cent), en clair comme tout
-- nombre. Sur un devis brouillon, NULL suit le réglage de l'espace, 0 dit
-- « pas d'acompte » : l'émission fige la valeur. Toujours NULL hors devis.
--
-- Rejouable : sonde d'existence, puis ajout sous garde. MySQL ne connaît pas
-- ADD COLUMN IF NOT EXISTS.

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ft_invoicing_docs'
      AND COLUMN_NAME = 'deposit_bp');

SET @s = IF(@has_column = 0,
    'ALTER TABLE ft_invoicing_docs ADD COLUMN deposit_bp INT NULL AFTER valid_until',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ft_invoicing_settings'
      AND COLUMN_NAME = 'default_deposit_bp');

SET @s = IF(@has_column = 0,
    'ALTER TABLE ft_invoicing_settings ADD COLUMN default_deposit_bp INT NOT NULL DEFAULT 0 AFTER quote_validity_days',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

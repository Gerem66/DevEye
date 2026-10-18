-- La conservation des retours, réglable par site. Ce sont des données que des
-- tiers ont écrites (noms, adresses, messages) : elles expirent comme les
-- événements, sur une durée à part et plus longue, un message attendant
-- parfois qu'on y réponde.
--
-- Rejouable : l'ajout est gardé par la lecture d'INFORMATION_SCHEMA.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'submission_retention_days');
SET @s = IF(@c = 0,
    'ALTER TABLE audience_sites ADD COLUMN submission_retention_days INT NOT NULL DEFAULT 365 AFTER retention_days',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

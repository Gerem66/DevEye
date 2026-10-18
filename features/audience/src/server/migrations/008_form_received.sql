-- Le total des retours reçus par un formulaire, que l'expiration ne fait pas
-- baisser : les résultats s'y rapportent, comptés sur toute la vie du
-- formulaire, quand le contenu des retours, lui, a expiré.
--
-- Rejouable : l'ajout est gardé par la lecture d'INFORMATION_SCHEMA, et la
-- reprise ne relève qu'un total resté sous les retours conservés.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_audience_forms' AND COLUMN_NAME = 'received');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_audience_forms ADD COLUMN received INT NOT NULL DEFAULT 0 AFTER submissions',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE ft_audience_forms SET received = submissions WHERE received < submissions;

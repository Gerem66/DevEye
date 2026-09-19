-- La cle d'API par ville disparait : une source ne se regle plus qu'a l'echelle
-- de l'espace (weather_provider_keys). La colonne posee par 011 ne se lit plus.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_locations' AND COLUMN_NAME = 'api_key_enc');
SET @s = IF(@c > 0, 'ALTER TABLE weather_locations DROP COLUMN api_key_enc', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

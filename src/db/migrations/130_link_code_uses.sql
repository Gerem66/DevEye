-- Un code de liaison sert un nombre de machines choisi a l'emission, et
-- used_at date desormais son dernier usage. Colonnes ajoutees sous garde
-- INFORMATION_SCHEMA + SQL dynamique, jamais `ADD COLUMN IF NOT EXISTS`.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_link_codes' AND COLUMN_NAME = 'max_uses');
SET @s = IF(@c = 0, 'ALTER TABLE device_link_codes ADD COLUMN max_uses INT NOT NULL DEFAULT 1 AFTER expires_at', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_link_codes' AND COLUMN_NAME = 'uses');
SET @s = IF(@c = 0, 'ALTER TABLE device_link_codes ADD COLUMN uses INT NOT NULL DEFAULT 0 AFTER max_uses', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Un code deja consomme a servi son unique usage.
UPDATE device_link_codes SET uses = max_uses WHERE used_at IS NOT NULL AND uses < max_uses;

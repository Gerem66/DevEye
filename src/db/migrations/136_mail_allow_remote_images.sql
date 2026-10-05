-- Une boîte peut afficher toutes les images distantes de ses messages, sans
-- bannière ni clic : un réglage de la boîte, éteint par défaut.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB).

SET @mail_images_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts' AND COLUMN_NAME = 'allow_remote_images');
SET @add_mail_images = IF(@mail_images_exists = 0,
    'ALTER TABLE mail_accounts ADD COLUMN allow_remote_images TINYINT NOT NULL DEFAULT 0 AFTER enabled',
    'SELECT 1');
PREPARE stmt FROM @add_mail_images; EXECUTE stmt; DEALLOCATE PREPARE stmt;

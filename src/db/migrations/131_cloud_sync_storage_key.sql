-- Un partage ne garde plus que la cle de son contenu dans le magasin d'objets
-- de l'hote (son dossier sous CLOUDSYNC_STORAGE_DIR, ou son prefixe dans le
-- bucket S3), jamais l'endroit ou elle se resout. Le chemin a toujours ete la
-- racine suivie de cette cle : son dernier segment suffit.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND COLUMN_NAME = 'storage_path');
SET @s = IF(@c = 1, 'UPDATE sync_shares SET storage_path = SUBSTRING_INDEX(storage_path, ''/'', -1)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = IF(@c = 1,
    'ALTER TABLE sync_shares CHANGE storage_path storage_key VARCHAR(100) NOT NULL, ADD UNIQUE KEY uniq_sync_shares_storage_key (storage_key)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

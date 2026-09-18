-- Le jeton d'un appareil expire désormais, et le serveur le renouvelle à la
-- connexion. `token_hash_prev` garde le condensé du jeton remplacé tant que
-- l'agent ne s'est pas authentifié avec le nouveau : une trame de rotation
-- perdue en vol ne doit pas couper une machine du serveur.
--
-- `public_key` s'en va : la clé que chaque agent générait à l'enrôlement n'a
-- jamais rien vérifié. La signature des ordres va dans l'autre sens (le serveur
-- signe, l'agent vérifie), sous une clé qui vit dans l'environnement du serveur.
--
-- Conditionnel via INFORMATION_SCHEMA + SQL dynamique : `ADD COLUMN IF NOT
-- EXISTS` et `DROP COLUMN IF EXISTS` sont des extensions MariaDB, refusées par
-- MySQL.
SET @token_hash_prev_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'token_hash_prev'
);
SET @add_token_hash_prev = IF(
    @token_hash_prev_exists = 0,
    'ALTER TABLE devices ADD COLUMN token_hash_prev CHAR(64) NULL AFTER token_hash',
    'SELECT 1'
);
PREPARE stmt FROM @add_token_hash_prev;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @public_key_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'public_key'
);
SET @drop_public_key = IF(
    @public_key_exists = 1,
    'ALTER TABLE devices DROP COLUMN public_key',
    'SELECT 1'
);
PREPARE stmt FROM @drop_public_key;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

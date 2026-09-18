-- Deux profils Argon2id coexistent désormais pour la clé d'emballage : `version`
-- dit sous lequel l'emballage par mot de passe a été dérivé, `recovery_version`
-- sous lequel la copie de récupération l'a été (elle ne monte qu'au prochain
-- usage du code, le serveur ne le connaît pas). Toutes les lignes existantes
-- sont au profil 1 : la valeur par défaut le dit, et le déverrouillage suivant
-- les fait passer au profil courant.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique : `ADD COLUMN IF
-- NOT EXISTS` est une extension MariaDB, refusée par MySQL.
SET @recovery_version_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_secret_keys' AND COLUMN_NAME = 'recovery_version'
);
SET @add_recovery_version = IF(
    @recovery_version_exists = 0,
    'ALTER TABLE user_secret_keys ADD COLUMN recovery_version INT NOT NULL DEFAULT 1 AFTER recovery_salt',
    'SELECT 1'
);
PREPARE stmt FROM @add_recovery_version;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

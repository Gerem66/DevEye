-- La dernière fois que le compte a ouvert ou utilisé l'application, ce que la
-- liste des membres d'un espace montre. `last_login` ne suit que la saisie du
-- mot de passe, qu'une session de trente jours ne redemande pas.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB).

SET @users_last_seen_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_seen');
SET @add_users_last_seen = IF(@users_last_seen_exists = 0,
    'ALTER TABLE users ADD COLUMN last_seen BIGINT NOT NULL DEFAULT 0 AFTER last_login',
    'SELECT 1');
PREPARE stmt FROM @add_users_last_seen; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Une connexion vaut au moins une visite.
UPDATE users SET last_seen = last_login WHERE last_seen < last_login;

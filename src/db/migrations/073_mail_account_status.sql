-- L'état d'une boîte mail, en clair et persistant. `last_sync_error_enc` ne
-- disait que la dernière relève de fond : une commande de l'utilisateur qui
-- échouait n'en laissait aucune trace.
--
--  * `last_sync_status` est en clair, comme `enabled` et `security_tier` : il
--    doit se lire sans clé (boîte « guarded » verrouillée, DEK indéballable).
--    Le libellé reste chiffré : il peut citer un hôte, une adresse, un jeton.
--  * `last_error_at` date l'échec courant. `last_sync_at` ne convient pas : il
--    marque la dernière tentative de relève de fond.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).

SET @mail_status_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts' AND COLUMN_NAME = 'last_sync_status');
SET @add_mail_status = IF(@mail_status_exists = 0,
    'ALTER TABLE mail_accounts ADD COLUMN last_sync_status VARCHAR(16) NOT NULL DEFAULT ''ok'' AFTER last_sync_at',
    'SELECT 1');
PREPARE stmt FROM @add_mail_status; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @mail_error_at_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts' AND COLUMN_NAME = 'last_error_at');
SET @add_mail_error_at = IF(@mail_error_at_exists = 0,
    'ALTER TABLE mail_accounts ADD COLUMN last_error_at BIGINT NULL AFTER last_sync_status',
    'SELECT 1');
PREPARE stmt FROM @add_mail_error_at; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Reprise : toute boîte qui porte déjà une erreur passe à `error`. Rejouable :
-- ne touche que les lignes encore à 'ok', donc une seconde exécution ne défait
-- pas une classification plus fine posée entre-temps par le serveur.
UPDATE mail_accounts
SET last_sync_status = 'error',
    last_error_at = COALESCE(last_error_at, last_sync_at, UNIX_TIMESTAMP())
WHERE last_sync_error_enc IS NOT NULL AND last_sync_status = 'ok';

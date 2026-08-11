-- L'état d'une boîte mail, en clair et persistant.
--
-- `last_sync_error_enc` existait déjà, mais il ne disait que la *dernière relève
-- de fond* : une commande de l'utilisateur qui échouait (ouvrir un dossier avec
-- un jeton révoqué, relever une boîte dont l'accès a changé) n'en laissait
-- aucune trace. Le compte paraissait sain, la liste s'affichait vide, et rien
-- n'expliquait pourquoi — il fallait provoquer l'échec à nouveau pour le voir.
--
-- Deux colonnes plutôt qu'une lecture du blob :
--
--  * `last_sync_status` est **en clair**, à côté d'`enabled` et de
--    `security_tier`, pour les mêmes raisons qu'eux : il doit se lire sans clé.
--    Une boîte « guarded » verrouillée, ou un compte dont la DEK ne se déballe
--    pas, gardent alors un état affichable — c'est précisément le cas où le
--    message d'erreur, lui, est illisible. Il sert aussi au diagnostic en SQL.
--    Le libellé reste chiffré : il peut citer un hôte, une adresse, un jeton.
--
--  * `last_error_at` date l'échec courant. `last_sync_at` ne convient pas : il
--    marque la dernière *tentative de relève de fond*, que l'échec d'une
--    commande ne fait pas bouger.
--
-- Reprise de l'existant : toute boîte qui porte déjà une erreur passe à
-- `error`, sans chercher à la classer — le blob n'est pas déchiffrable ici, et
-- la première opération réussie ou échouée tranchera d'elle-même.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, JAMAIS via
-- `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la production au
-- démarrage (voir 038_uptime_order.sql).

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

-- Rejouable : ne touche que les lignes encore à 'ok' alors qu'une erreur est
-- enregistrée, donc une seconde exécution ne défait pas une classification plus
-- fine posée entre-temps par le serveur.
UPDATE mail_accounts
SET last_sync_status = 'error',
    last_error_at = COALESCE(last_error_at, last_sync_at, UNIX_TIMESTAMP())
WHERE last_sync_error_enc IS NOT NULL AND last_sync_status = 'ok';

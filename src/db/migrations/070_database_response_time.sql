-- Le temps de réponse du dernier relevé d'une base.
--
-- Le chiffre existait déjà — « Tester » l'affiche — mais il mourait avec la
-- réponse : rien n'en gardait trace, et le bandeau de la fiche ne pouvait donc
-- pas dire si la base répondait en 40 ms ou en 4 s au dernier passage. C'est
-- pourtant le premier signe d'une base qui se dégrade, bien avant qu'elle
-- devienne injoignable.
--
-- Une colonne, et non le blob chiffré `content` : elle est écrite par le relevé
-- (`recordCheck`), à côté de `last_check_at` et pour les mêmes raisons — ce sont
-- des mesures, pas des réglages, et `content` n'est pas réécrit par un relevé.
--
-- Renseignée **aussi sur un échec** : un relevé qui met douze secondes à échouer
-- dit quelque chose qu'un simple « injoignable » ne dit pas.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, JAMAIS via
-- `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la production au
-- démarrage (voir 038_uptime_order.sql).

SET @db_elapsed_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_connections' AND COLUMN_NAME = 'last_elapsed_ms');
SET @add_db_elapsed = IF(@db_elapsed_exists = 0,
    'ALTER TABLE database_connections ADD COLUMN last_elapsed_ms INT NULL AFTER last_check_at',
    'SELECT 1');
PREPARE stmt FROM @add_db_elapsed; EXECUTE stmt; DEALLOCATE PREPARE stmt;

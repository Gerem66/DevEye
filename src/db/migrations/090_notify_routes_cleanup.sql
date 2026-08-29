-- Les routes de notification suivent leur élément, et Uptime entre dans le rang.
--
-- ## 1. Les routes orphelines
--
-- Un élément supprimé laissait sa route, et comme la présence d'une route vaut
-- « réglé à la main », le prochain élément à hériter de l'identifiant adoptait
-- le routage du mort. Le code fait le ménage désormais (`clearRoute`), ceci
-- résorbe l'existant. Les liaisons partent en CASCADE. `item_id <> 0` : la
-- route de la fonctionnalité n'a pas d'élément à suivre. Comparaisons à des
-- littéraux uniquement : pas de « Illegal mix of collations » (voir 087).

DELETE r FROM notification_routes r
WHERE r.feature = 'uptime' AND r.item_id <> 0
  AND NOT EXISTS (SELECT 1 FROM uptime_services s
                  WHERE s.id = r.item_id AND s.workspace_id = r.workspace_id);

DELETE r FROM notification_routes r
WHERE r.feature = 'database' AND r.item_id <> 0
  AND NOT EXISTS (SELECT 1 FROM database_connections d
                  WHERE d.id = r.item_id AND d.workspace_id = r.workspace_id);

DELETE r FROM notification_routes r
WHERE r.feature = 'deploy' AND r.item_id <> 0
  AND NOT EXISTS (SELECT 1 FROM deploy_targets t
                  WHERE t.id = r.item_id AND t.workspace_id = r.workspace_id);

DELETE r FROM notification_routes r
WHERE r.feature = 'backup' AND r.item_id <> 0
  AND NOT EXISTS (SELECT 1 FROM backup_jobs j
                  WHERE j.id = r.item_id AND j.workspace_id = r.workspace_id);

-- ## 2. `uptime_services.notify` devient une route explicite
--
-- Uptime portait deux interrupteurs : sa route et une case `notify`. Route
-- absente = hérite d'Uptime, route présente et vide = silence explicite. Un
-- service `notify = 0` devient donc une route vide (créée si absente, vidée si
-- elle avait des canaux : la case primait). Puis la colonne tombe.
--
-- Rejouable : les instructions qui lisent `notify` sont gardées sur l'existence
-- de la colonne (INFORMATION_SCHEMA + PREPARE). L'INSERT s'appuie sur
-- `uniq_notif_route` (IGNORE), le DELETE est idempotent.

SET @has_notify = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'notify');

SET @s = IF(@has_notify = 1, "
INSERT IGNORE INTO notification_routes (workspace_id, feature, item_id)
SELECT s.workspace_id, 'uptime', s.id
FROM uptime_services s
WHERE s.notify = 0", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_notify = 1, "
DELETE rc FROM notification_route_channels rc
JOIN notification_routes r ON r.id = rc.route_id
JOIN uptime_services s ON s.id = r.item_id AND s.workspace_id = r.workspace_id
WHERE r.feature = 'uptime' AND s.notify = 0", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_notify = 1, 'ALTER TABLE uptime_services DROP COLUMN notify', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

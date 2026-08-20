-- Les routes de notification suivent leur élément, et Uptime entre dans le rang.
--
-- ## 1. Les routes orphelines
--
-- La 087 posait « le nettoyage est applicatif, à la suppression de l'élément »,
-- mais aucun des quatre émetteurs à éléments ne le faisait. Conséquence, deux
-- fois vicieuse : un élément supprimé laissait sa route, et comme la **présence**
-- d'une route vaut « réglé à la main », le prochain élément à hériter de
-- l'identifiant adoptait en silence le routage du mort, sans même retomber sur
-- celui de sa fonctionnalité. Le code fait le ménage désormais (les quatre
-- handlers `remove` appellent `clearRoute`) ; ceci résorbe l'existant.
--
-- Les liaisons `notification_route_channels` partent en CASCADE avec la route.
-- `item_id <> 0` : la route de la fonctionnalité elle-même n'a pas d'élément à
-- suivre, elle ne peut pas être orpheline. Comparaisons à des littéraux
-- uniquement : pas de « Illegal mix of collations » possible (voir 087).

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
-- Uptime était le seul émetteur à porter **deux** interrupteurs : sa route
-- (comme les quatre autres depuis la 087) et une case `notify` héritée d'avant,
-- dans un autre dialogue. Un service pouvait avoir une route parfaitement réglée
-- et rester muet à cause d'une case que rien ne signalait ; deux endroits pour
-- une même décision finissent toujours par se contredire.
--
-- La sémantique de la 087 sait déjà tout dire : route absente = hérite d'Uptime,
-- route **présente et vide** = silence explicite. Un service `notify = 0`
-- devient donc une route vide (créée si absente, vidée si elle avait des
-- canaux : la case primait sur la route, on préserve le comportement) ; un
-- service `notify = 1` ne change pas. Puis la colonne tombe.
--
-- ### Rejouabilité
--
-- `migrate.ts` exécute sans transaction et rejoue depuis le début en cas
-- d'interruption (voir 087). Les trois instructions qui lisent `notify`
-- échoueraient au rejeu une fois la colonne tombée : elles sont gardées sur son
-- existence via INFORMATION_SCHEMA + PREPARE/EXECUTE, le motif des 038, 080,
-- 085 et 087. L'INSERT s'appuie sur la clé unique `uniq_notif_route` (IGNORE),
-- le DELETE est naturellement idempotent.

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

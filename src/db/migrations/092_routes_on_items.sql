-- La sélection de canaux vit sur l'élément : fin de l'héritage. La feature
-- liste ses canaux (ses sources), chaque élément sélectionne les siens. Les
-- routes de fonctionnalité ne subsistent que pour les émetteurs sans éléments
-- (Sentinelle).
--
-- Reprise : la route de feature est matérialisée sur chacun de ses éléments
-- qui en héritait, liaison par liaison, puis supprimée. Un élément qui avait sa
-- propre route la garde. Les routes vides sont retirées (vide et absente
-- disent désormais la même chose). Un élément créé ensuite naît silencieux.
--
-- Rejouable : même armature que la 091 (phase A gardée sur l'absence de
-- `seed_from`, phase B sur sa présence, instructions idempotentes).

-- ── Phase A : la colonne de travail ─────────────────────────────────────────

SET @has_seed = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_routes' AND COLUMN_NAME = 'seed_from');

SET @s = IF(@has_seed = 0, 'ALTER TABLE notification_routes ADD COLUMN seed_from INT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_seed = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_routes' AND COLUMN_NAME = 'seed_from');

-- ── Phase B : matérialiser, relier, supprimer ───────────────────────────────

-- Une route par élément héritant, marquée `seed_from` = la route de feature
-- qu'elle matérialise. INSERT IGNORE sur `uniq_notif_route` : un élément qui a
-- déjà sa route n'est pas touché. Seules les routes de feature avec liaisons
-- comptent.

SET @s = IF(@has_seed = 1, "
INSERT IGNORE INTO notification_routes (workspace_id, feature, item_id, seed_from)
SELECT s.workspace_id, 'uptime', s.id, fr.id
  FROM uptime_services s
  JOIN notification_routes fr
    ON fr.workspace_id = s.workspace_id AND fr.feature = 'uptime' AND fr.item_id = 0
 WHERE EXISTS (SELECT 1 FROM notification_route_channels frc WHERE frc.route_id = fr.id)", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_seed = 1, "
INSERT IGNORE INTO notification_routes (workspace_id, feature, item_id, seed_from)
SELECT d.workspace_id, 'database', d.id, fr.id
  FROM database_connections d
  JOIN notification_routes fr
    ON fr.workspace_id = d.workspace_id AND fr.feature = 'database' AND fr.item_id = 0
 WHERE EXISTS (SELECT 1 FROM notification_route_channels frc WHERE frc.route_id = fr.id)", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_seed = 1, "
INSERT IGNORE INTO notification_routes (workspace_id, feature, item_id, seed_from)
SELECT t.workspace_id, 'deploy', t.id, fr.id
  FROM deploy_targets t
  JOIN notification_routes fr
    ON fr.workspace_id = t.workspace_id AND fr.feature = 'deploy' AND fr.item_id = 0
 WHERE EXISTS (SELECT 1 FROM notification_route_channels frc WHERE frc.route_id = fr.id)", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_seed = 1, "
INSERT IGNORE INTO notification_routes (workspace_id, feature, item_id, seed_from)
SELECT j.workspace_id, 'backup', j.id, fr.id
  FROM backup_jobs j
  JOIN notification_routes fr
    ON fr.workspace_id = j.workspace_id AND fr.feature = 'backup' AND fr.item_id = 0
 WHERE EXISTS (SELECT 1 FROM notification_route_channels frc WHERE frc.route_id = fr.id)", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les liaisons de la route de feature, recopiées sur chaque route matérialisée.
-- Idempotent par la clé primaire de la table de liaison.
SET @s = IF(@has_seed = 1, "
INSERT IGNORE INTO notification_route_channels (route_id, channel_id)
SELECT r.id, frc.channel_id
  FROM notification_routes r
  JOIN notification_route_channels frc ON frc.route_id = r.seed_from
 WHERE r.seed_from IS NOT NULL", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les routes de feature des émetteurs à éléments n'ont plus de sens, celle de
-- Sentinelle (sans éléments) reste. Les liaisons partent en cascade.
SET @s = IF(@has_seed = 1, "
DELETE FROM notification_routes
 WHERE item_id = 0 AND feature IN ('uptime', 'database', 'deploy', 'backup')", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Vide = absente, désormais : les anciennes routes « silence explicite » ne
-- disent plus rien que leur absence ne dise aussi.
SET @s = IF(@has_seed = 1, "
DELETE r FROM notification_routes r
 WHERE r.item_id <> 0
   AND NOT EXISTS (SELECT 1 FROM notification_route_channels rc WHERE rc.route_id = r.id)", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La colonne de travail part en dernier : c'est elle qui garde la phase B.
SET @s = IF(@has_seed = 1, 'ALTER TABLE notification_routes DROP COLUMN seed_from', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

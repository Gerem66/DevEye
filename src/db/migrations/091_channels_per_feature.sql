-- Chaque émetteur a SES canaux : `notification_channels` gagne `feature`. Un
-- canal devient une source de sa fonctionnalité, comme un jeton Dokploy l'est du
-- Déploiement. Prix assumé : deux features qui préviennent le même salon le
-- déclarent deux fois.
--
-- Répartition de l'existant, par les features qui routent le canal :
--   - une seule le désigne : il devient le sien,
--   - plusieurs : il est recopié (les cryptogrammes se déplacent tels quels,
--     pas d'AAD), une copie par feature de plus, liaisons re-pointées.
--     `split_from` corrèle copie et original le temps de la migration,
--   - aucune : supprimé, rien ne partait par lui.
--
-- Rejouable : la phase A est gardée sur l'absence de `feature`, la phase B sur
-- la présence de `split_from`, supprimée en dernier. Chaque instruction est
-- idempotente (`feature IS NULL`, INSERT IGNORE sur `(split_from, feature)`).
-- Les comparaisons colonne-à-colonne restent entre tables en
-- `utf8mb4_general_ci` (087 et celle-ci).

-- ── Phase A : les colonnes ──────────────────────────────────────────────────

SET @has_feature = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_channels' AND COLUMN_NAME = 'feature');

SET @s = IF(@has_feature = 0, "
ALTER TABLE notification_channels
    ADD COLUMN feature VARCHAR(24) NULL AFTER workspace_id,
    ADD COLUMN split_from INT NULL,
    ADD UNIQUE KEY uniq_notif_split (split_from, feature)", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Phase B : répartition, puis ménage ──────────────────────────────────────

SET @has_scratch = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_channels' AND COLUMN_NAME = 'split_from');

-- La première feature qui route le canal (MIN : déterministe) devient la
-- sienne, les autres recevront une copie.
SET @s = IF(@has_scratch = 1, "
UPDATE notification_channels c
   SET c.feature = (SELECT MIN(r.feature)
                      FROM notification_route_channels rc
                      JOIN notification_routes r ON r.id = rc.route_id
                     WHERE rc.channel_id = c.id)
 WHERE c.feature IS NULL", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Une copie par feature supplémentaire. L'idempotence tient à la clé unique
-- `(split_from, feature)` + IGNORE, jamais à un EXISTS sur la table visée
-- (refusé selon les versions de MySQL).
SET @s = IF(@has_scratch = 1, "
INSERT IGNORE INTO notification_channels
    (workspace_id, feature, kind, label_enc, target_enc, mail_account_id, enabled, position, created, split_from)
SELECT c.workspace_id, rf.feature, c.kind, c.label_enc, c.target_enc, c.mail_account_id,
       c.enabled, c.position, c.created, c.id
  FROM notification_channels c
  JOIN (SELECT DISTINCT rc.channel_id, r.feature
          FROM notification_route_channels rc
          JOIN notification_routes r ON r.id = rc.route_id) rf
    ON rf.channel_id = c.id AND rf.feature <> c.feature
 WHERE c.split_from IS NULL", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les liaisons des autres features basculent vers leur copie. Après un premier
-- passage, `src.feature <> r.feature` ne matche plus rien : idempotent.
SET @s = IF(@has_scratch = 1, "
UPDATE notification_route_channels rc
  JOIN notification_routes r   ON r.id = rc.route_id
  JOIN notification_channels src ON src.id = rc.channel_id AND src.feature <> r.feature
  JOIN notification_channels c2  ON c2.split_from = src.id AND c2.feature = r.feature
   SET rc.channel_id = c2.id", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les canaux que rien ne route n'ont pas de feature à qui appartenir.
SET @s = IF(@has_scratch = 1, 'DELETE FROM notification_channels WHERE feature IS NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_scratch = 1, 'ALTER TABLE notification_channels MODIFY feature VARCHAR(24) NOT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- L'index des listes suit la nouvelle porte d'entrée (espace + feature).
SET @has_new_idx = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_channels' AND INDEX_NAME = 'idx_notif_channels_ws_feature');
SET @s = IF(@has_scratch = 1 AND @has_new_idx = 0, "
ALTER TABLE notification_channels
    DROP INDEX idx_notif_channels_ws,
    ADD INDEX idx_notif_channels_ws_feature (workspace_id, feature, position)", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La colonne de travail part en dernier : c'est elle qui garde la phase B.
SET @s = IF(@has_scratch = 1, "
ALTER TABLE notification_channels
    DROP INDEX uniq_notif_split,
    DROP COLUMN split_from", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

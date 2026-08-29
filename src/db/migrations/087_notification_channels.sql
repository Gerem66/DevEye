-- Les canaux d'alerte : une liste d'espace, et des routes qui pointent dessus.
--
-- La 075 gardait deux canaux binaires (mail, webhook) par `(espace, feature)` :
-- le même salon redéclaré cinq fois, un seul destinataire par émetteur, aucun
-- routage par élément.
--
-- `notification_channels` porte les destinations à l'échelle de l'espace.
-- `notification_routes` + `notification_route_channels` disent qui écrit où. La
-- liaison est séparée parce que la présence d'une ligne `notification_routes`
-- vaut « réglé à la main » et son absence « hérite de sa fonctionnalité » : une
-- route sans liaison exprime « silencieux ».
-- `item_id = 0` désigne la fonctionnalité elle-même : une colonne d'une clé
-- unique ne peut pas être nulle.

CREATE TABLE IF NOT EXISTS notification_channels (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT         NOT NULL,
    -- 'email' | 'webhook' | 'discord' (`notificationChannelKindSchema`). Une
    -- déclaration, jamais devinée depuis l'URL.
    kind            VARCHAR(16) NOT NULL,
    -- Nom donné par l'utilisateur, chiffré à l'étage ouvert (les boucles de
    -- fond relisent tout ceci sans session). NULL = jamais nommé, l'état que
    -- la reprise laisse (aucune requête SQL ne produit un cryptogramme) : le
    -- serveur retombe alors sur la destination elle-même.
    label_enc       TEXT        NULL,
    -- Adresse destinataire ('email') ou URL appelée en POST (webhook/discord).
    --
    -- NULL sur un 'email' = l'adresse du compte expéditeur lui-même, exactement
    -- ce que `notification_settings.email_enc IS NULL` voulait déjà dire.
    target_enc      TEXT        NULL,
    -- Le compte Mail expéditeur. Aucune FK : sa disparition ne doit pas effacer
    -- le canal, le serveur vérifie l'appartenance et le palier à chaque
    -- résolution.
    mail_account_id INT         NULL,
    -- Éteint sans être supprimé : ses routes restent, rien ne part.
    enabled         TINYINT     NOT NULL DEFAULT 1,
    position        INT         NOT NULL DEFAULT 0,
    created         BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_notif_channels_ws (workspace_id, position),
    CONSTRAINT fk_notif_channel_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS notification_routes (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT         NOT NULL,
    -- 'uptime' | 'sentinel' | 'database' | 'deploy' | 'backup'
    feature      VARCHAR(24) NOT NULL,
    -- 0 = la fonctionnalité elle-même, sinon l'identifiant d'un de ses éléments.
    -- Pas de FK : la cible vit dans une table différente selon la feature. Le
    -- nettoyage est applicatif, à la suppression de l'élément.
    item_id      INT         NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_notif_route (workspace_id, feature, item_id),
    CONSTRAINT fk_notif_route_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS notification_route_channels (
    route_id   INT NOT NULL,
    channel_id INT NOT NULL,
    PRIMARY KEY (route_id, channel_id),
    KEY idx_notif_rc_channel (channel_id),
    CONSTRAINT fk_notif_rc_route FOREIGN KEY (route_id) REFERENCES notification_routes(id) ON DELETE CASCADE,
    CONSTRAINT fk_notif_rc_channel FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ## Reprise des réglages existants
--
-- À l'identique : chaque canal activé d'une ligne existante devient un canal,
-- et la route de sa fonctionnalité le désigne.
--
-- Rejouable : les trois insertions se gardent sur l'absence de la route, créée
-- en dernier, jamais sur l'absence du canal (un `INSERT ... SELECT` qui
-- interroge sa propre table est refusé selon les versions de MySQL).
--
-- Collation sur la comparaison : la connexion de MySQL 8 parle
-- `utf8mb4_0900_ai_ci`, et un `r.feature = s.feature` entre deux colonnes de
-- collations différentes échoue en « Illegal mix of collations » là où une
-- comparaison à un littéral passe. Les rangs passent donc par un `CASE` sur
-- littéraux, et la seule comparaison colonne-à-colonne porte un `COLLATE`.
--
-- Le rattachement passe par `position` : la 085 a recopié `email_enc` et
-- `webhook_enc` octet pour octet d'une feature à l'autre, donc un rapprochement
-- par valeur produirait un produit croisé. `position` = rang de la feature × 2 +
-- (0 mail, 1 webhook), unique par `(espace, feature, type)`.
--
-- Les doublons ne peuvent pas être fusionnés ici (chiffrement non déterministe),
-- et tout webhook entre en `webhook`, jamais en `discord` (le SQL ne lit pas
-- l'URL) : le comportement reste celui d'avant.
--
-- Les quatre reprises et le DROP sont gardés par INFORMATION_SCHEMA + PREPARE :
-- sans transaction, un fichier interrompu rejoue depuis le début et échouerait
-- sur une `notification_settings` déjà supprimée, bloquant le boot.

SET @has_old_settings = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_settings');

SET @s = IF(@has_old_settings = 1, "
INSERT INTO notification_channels (workspace_id, kind, label_enc, target_enc, mail_account_id, enabled, position)
SELECT s.workspace_id, 'email', NULL, s.email_enc, s.mail_account_id, 1,
       (CASE s.feature WHEN 'uptime' THEN 0 WHEN 'sentinel' THEN 1 WHEN 'database' THEN 2
                       WHEN 'deploy' THEN 3 WHEN 'backup' THEN 4 END) * 2
FROM notification_settings s
WHERE s.email_enabled = 1
  AND s.feature IN ('uptime', 'sentinel', 'database', 'deploy', 'backup')
  AND NOT EXISTS (
      SELECT 1 FROM notification_routes r
      WHERE r.workspace_id = s.workspace_id
        AND r.feature = s.feature COLLATE utf8mb4_general_ci
        AND r.item_id = 0
  )", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_old_settings = 1, "
INSERT INTO notification_channels (workspace_id, kind, label_enc, target_enc, mail_account_id, enabled, position)
SELECT s.workspace_id, 'webhook', NULL, s.webhook_enc, NULL, 1,
       (CASE s.feature WHEN 'uptime' THEN 0 WHEN 'sentinel' THEN 1 WHEN 'database' THEN 2
                       WHEN 'deploy' THEN 3 WHEN 'backup' THEN 4 END) * 2 + 1
FROM notification_settings s
WHERE s.webhook_enabled = 1
  AND s.webhook_enc IS NOT NULL
  AND s.feature IN ('uptime', 'sentinel', 'database', 'deploy', 'backup')
  AND NOT EXISTS (
      SELECT 1 FROM notification_routes r
      WHERE r.workspace_id = s.workspace_id
        AND r.feature = s.feature COLLATE utf8mb4_general_ci
        AND r.item_id = 0
  )", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_old_settings = 1, "
INSERT INTO notification_routes (workspace_id, feature, item_id)
SELECT s.workspace_id, s.feature, 0
FROM notification_settings s
WHERE (s.email_enabled = 1 OR (s.webhook_enabled = 1 AND s.webhook_enc IS NOT NULL))
  AND s.feature IN ('uptime', 'sentinel', 'database', 'deploy', 'backup')
  AND NOT EXISTS (
      SELECT 1 FROM notification_routes r
      WHERE r.workspace_id = s.workspace_id
        AND r.feature = s.feature COLLATE utf8mb4_general_ci
        AND r.item_id = 0
  )", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO notification_route_channels (route_id, channel_id)
SELECT r.id, c.id
FROM notification_routes r
JOIN notification_channels c
  ON c.workspace_id = r.workspace_id
 AND c.label_enc IS NULL
 AND c.position IN (
        (CASE r.feature WHEN 'uptime' THEN 0 WHEN 'sentinel' THEN 1 WHEN 'database' THEN 2
                        WHEN 'deploy' THEN 3 WHEN 'backup' THEN 4 END) * 2,
        (CASE r.feature WHEN 'uptime' THEN 0 WHEN 'sentinel' THEN 1 WHEN 'database' THEN 2
                        WHEN 'deploy' THEN 3 WHEN 'backup' THEN 4 END) * 2 + 1
     )
WHERE r.item_id = 0;

-- Fin de l'ancienne table : deux jeux de réglages jumeaux auraient dérivé dès
-- la première évolution.
SET @s = IF(@has_old_settings = 1, 'DROP TABLE notification_settings', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

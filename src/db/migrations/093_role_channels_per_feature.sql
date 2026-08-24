-- « Gérer les canaux d'alerte » passe de l'espace à la fonctionnalité.
--
-- La capacité `workspace.notifications` accordait la gestion de TOUS les
-- canaux d'un coup. Depuis que chaque émetteur possède les siens (091), ce
-- bloc unique confiait l'astreinte d'Uptime avec le salon des sauvegardes. Le
-- droit devient un champ `channels` porté par chaque grant de fonctionnalité
-- du rôle (`features[*].channels`), et la capacité disparaît.
--
-- ## Ce que la reprise préserve
--
-- Un rôle qui portait la capacité gérait les canaux de toutes les
-- fonctionnalités qu'il voyait (les commandes exigeaient aussi la lecture de
-- la fonctionnalité propriétaire) : il reçoit `channels: true` sur chacun de
-- ses grants. Un rôle sans la capacité reçoit `channels: false` partout. Les
-- droits effectifs d'hier sont donc exactement ceux de demain.
--
-- ## Rejouabilité
--
-- Même armature que la 091 : phase A gardée sur l'absence de la colonne de
-- travail `notif_cap`, phase B gardée sur sa présence et composée
-- d'instructions idempotentes, la colonne tombant en dernier. La colonne fige
-- « le rôle portait la capacité » AVANT qu'on la retire du JSON : sans elle,
-- un rejeu relirait des capacités déjà nettoyées et écraserait `channels` à
-- false.

-- ── Phase A : la colonne de travail ─────────────────────────────────────────

SET @has_cap = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_roles' AND COLUMN_NAME = 'notif_cap');

SET @s = IF(@has_cap = 0, 'ALTER TABLE workspace_roles ADD COLUMN notif_cap TINYINT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_cap = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_roles' AND COLUMN_NAME = 'notif_cap');

-- ── Phase B : figer, reporter, nettoyer ─────────────────────────────────────

-- Le verdict est figé une fois par ligne (WHERE notif_cap IS NULL) : les
-- passages suivants le relisent dans la colonne, jamais dans un JSON qui a pu
-- être nettoyé entre-temps.
SET @s = IF(@has_cap = 1, "
UPDATE workspace_roles
   SET notif_cap = IF(JSON_CONTAINS(capabilities, '\"workspace.notifications\"'), 1, 0)
 WHERE notif_cap IS NULL", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Chaque grant reçoit son champ `channels`, en booléen JSON (pas 0/1 : le
-- contrat le valide comme booléen). Idempotent : JSON_SET réécrit la même
-- valeur, lue dans la colonne figée. Les rôles au tableau vide n'apparaissent
-- pas dans la table dérivée et n'ont rien à recevoir.
SET @s = IF(@has_cap = 1, "
UPDATE workspace_roles r
  JOIN (SELECT wr.id,
               JSON_ARRAYAGG(JSON_SET(jt.g, '$.channels',
                   IF(wr.notif_cap = 1, CAST('true' AS JSON), CAST('false' AS JSON)))) AS nf
          FROM workspace_roles wr
          JOIN JSON_TABLE(wr.features, '$[*]' COLUMNS (g JSON PATH '$')) jt
         GROUP BY wr.id) x ON x.id = r.id
   SET r.features = x.nf", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La capacité quitte le JSON : le contrat ne la connaît plus, et une valeur
-- inconnue ferait échouer la validation de sortie de `workspace.roleList`.
SET @s = IF(@has_cap = 1, "
UPDATE workspace_roles
   SET capabilities = JSON_REMOVE(capabilities,
       JSON_UNQUOTE(JSON_SEARCH(capabilities, 'one', 'workspace.notifications')))
 WHERE JSON_SEARCH(capabilities, 'one', 'workspace.notifications') IS NOT NULL", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La colonne de travail part en dernier : c'est elle qui garde la phase B.
SET @s = IF(@has_cap = 1, 'ALTER TABLE workspace_roles DROP COLUMN notif_cap', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

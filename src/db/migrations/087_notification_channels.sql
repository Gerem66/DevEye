-- Les canaux d'alerte : une liste d'espace, et des routes qui pointent dessus.
--
-- ## Ce que la 075 avait résolu, et ce qu'elle avait laissé
--
-- La 075 a séparé la **configuration** des émetteurs, et c'était juste : une
-- alerte de sécurité n'a rien à faire sur le salon de la disponibilité. Mais
-- elle a gardé la forme d'origine — deux canaux binaires, un mail et un webhook,
-- dans une ligne par couple `(espace, feature)`. Trois limites en découlaient :
--
--  1. **Le même salon Discord redéclaré cinq fois.** La 085 le dit sans le dire
--     en recopiant la ligne `uptime` dans `database` : la reprise était la bonne
--     décision, mais elle a produit deux exemplaires d'une même adresse, que
--     rien ne relie et qu'il faut désormais corriger deux fois.
--  2. **Un seul destinataire par émetteur.** Une équipe pour la production, une
--     autre pour la recette : impossible sans choisir.
--  3. **Aucun routage par élément.** Toutes les bases d'un espace prévenaient
--     les mêmes gens, quel que soit le projet derrière.
--
-- ## Trois tables, et pourquoi trois
--
-- `notification_channels` porte les destinations, à l'échelle de l'espace. C'est
-- ce qui rend une adresse corrigeable **à un seul endroit**.
--
-- `notification_routes` + `notification_route_channels` disent qui écrit où. La
-- table de liaison est séparée pour une raison précise : la **présence** d'une
-- ligne `notification_routes` pour un élément vaut « réglé à la main », son
-- absence vaut « hérite de sa fonctionnalité ». Une route existante sans aucune
-- liaison exprime donc « silencieux », ce qu'un tableau d'identifiants dans une
-- colonne ne saurait pas distinguer de « pas encore réglé ». Les clés étrangères
-- en CASCADE font le ménage dans les deux sens.
--
-- `item_id = 0` désigne la fonctionnalité elle-même : une colonne d'une clé
-- unique ne peut pas être nulle. La sentinelle est portée par le stockage, pas
-- par le contrat, qui rend simplement `itemId` absent.

CREATE TABLE IF NOT EXISTS notification_channels (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT         NOT NULL,
    -- 'email' | 'webhook' | 'discord' — `notificationChannelKindSchema`.
    --
    -- `discord` était jusqu'ici **deviné** en analysant l'URL. Ça marchait, mais
    -- décidait à la place de l'utilisateur : un point d'entrée maison servi
    -- depuis un domaine Discord aurait reçu des embeds au lieu de son texte, et
    -- rien ne permettait de demander l'inverse. C'est une déclaration.
    kind            VARCHAR(16) NOT NULL,
    -- Nom donné par l'utilisateur, chiffré à l'étage **ouvert** — ce sont les
    -- boucles de fond qui relisent tout ceci, sans session ni mot de passe.
    --
    -- **NULL = jamais nommé**, et c'est l'état dans lequel la reprise ci-dessous
    -- laisse les canaux qu'elle crée : aucune requête SQL ne peut produire un
    -- cryptogramme, et y écrire du clair rendrait `tryDecrypt` NULL à la
    -- lecture — un libellé vide au lieu d'un libellé faux, mais un libellé perdu
    -- quand même. Le serveur retombe alors sur la destination elle-même, ce qui
    -- est la meilleure description possible d'un canal que personne n'a nommé.
    label_enc       TEXT        NULL,
    -- Adresse destinataire ('email') ou URL appelée en POST (webhook/discord).
    --
    -- NULL sur un 'email' = l'adresse du compte expéditeur lui-même, exactement
    -- ce que `notification_settings.email_enc IS NULL` voulait déjà dire.
    target_enc      TEXT        NULL,
    -- Le compte Mail expéditeur. Aucune FK, comme dans la 075 : il vit dans un
    -- autre espace de nommage et sa disparition ne doit pas effacer le canal —
    -- le serveur vérifie l'appartenance et le palier à chaque résolution.
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
    -- 0 = la fonctionnalité elle-même ; sinon l'identifiant d'un de ses éléments.
    --
    -- Pas de FK : la cible vit dans une table différente selon la feature
    -- (`uptime_services`, `database_connections`, `deploy_targets`,
    -- `backup_jobs`). Le nettoyage est applicatif, à la suppression de l'élément.
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
-- À l'identique, comme la 075 et la 085 l'ont fait avant : personne ne doit
-- perdre au redémarrage une alerte qu'il recevait la veille. Chaque canal activé
-- d'une ligne existante devient un canal, et la route de sa fonctionnalité le
-- désigne.
--
-- ### Rejouabilité, et le marqueur choisi
--
-- Les trois insertions de canaux et de routes se gardent sur **l'absence de la
-- route**, jamais sur l'absence du canal : une garde qui interrogerait
-- `notification_channels` depuis un `INSERT … SELECT` visant cette même table
-- est un motif que MySQL n'accepte pas partout, et le premier `SELECT` du
-- fichier déciderait alors de tout. La route est créée **en dernier** parmi les
-- trois, donc sa présence prouve que les deux précédentes ont abouti. La table
-- de liaison, elle, se protège par son `INSERT IGNORE` et sa clé primaire.
--
-- ### Collation : sur la comparaison, pas seulement sur les tables
--
-- Déclarer `utf8mb4_general_ci` sur les trois tables créées ne suffit pas, et la
-- 080 le documentait déjà : la connexion de MySQL 8 parle `utf8mb4_0900_ai_ci`,
-- si bien qu'un `r.feature = s.feature` entre deux **colonnes** de collations
-- différentes échoue en « Illegal mix of collations » — là où une comparaison à
-- un littéral passe, la collation de la colonne l'emportant. Mesuré sur une base
-- de contrôle : la migration s'arrêtait à la première insertion, et sans
-- transaction, elle aurait laissé les tables créées et vides.
--
-- Les rangs passent donc par un `CASE` sur littéraux plutôt que par une table
-- dérivée, et la seule comparaison colonne-à-colonne qui reste porte un `COLLATE`
-- explicite.
--
-- ### Le rattachement, et pourquoi il passe par `position`
--
-- On ne peut pas rapprocher un canal de sa ligne d'origine par son contenu : la
-- 085 a recopié `email_enc` et `webhook_enc` **octet pour octet** de la ligne
-- `uptime` vers la ligne `database`, si bien que deux features d'un même espace
-- portent des cryptogrammes identiques. Un rapprochement par valeur produirait
-- un produit croisé — les deux canaux liés aux deux routes. `position` porte
-- donc une place déterministe, `rang de la feature × 2 + (0 mail, 1 webhook)`,
-- unique par `(espace, feature, type)`. Elle reste ensuite une simple place
-- d'affichage, que le premier réordonnancement réécrit.
--
-- ### Deux limites assumées, à connaître
--
-- **Les doublons ne peuvent pas être fusionnés ici.** Le chiffrement est non
-- déterministe : hors du cas de recopie ci-dessus, deux lignes portant la même
-- URL ont deux cryptogrammes différents, et aucune requête SQL ne peut les
-- rapprocher. Un espace qui avait réglé le même salon sur cinq émetteurs obtient
-- donc cinq lignes. La colonne « utilisé par N » les rend visibles et la
-- suppression prend deux clics — c'est le prix, payé une fois, de ne rien
-- déchiffrer en migration.
--
-- **Tout webhook entre en `webhook`, jamais en `discord`.** Le SQL ne peut pas
-- lire l'URL pour reconnaître Discord. L'écran le reconnaît à l'affichage et
-- propose la bascule ; jusque-là le comportement est **exactement** celui
-- d'avant, puisque l'ancien envoi retombait de toute façon sur le texte pour
-- les trois émetteurs qui n'avaient pas d'embed.

-- ### Rejouabilité : les quatre reprises et le DROP sont conditionnés
--
-- `migrate.ts` exécute le fichier en **une** requête multi-instructions, sans
-- transaction, et n'enregistre le nom qu'après son succès. Si quoi que ce soit
-- interrompt la fin du fichier — une erreur, une connexion coupée — les
-- instructions déjà passées sont committées et la migration rejoue **depuis le
-- début** au démarrage suivant. Écrite naïvement, elle échouerait alors sur une
-- `notification_settings` déjà supprimée et **bloquerait définitivement le
-- boot**, exactement ce que décrit `WORKSPACES.md` §7.
--
-- Vérifié : sans cette garde, une seconde exécution s'arrête sur
-- « Table 'notification_settings' doesn't exist ». Les cinq instructions passent
-- donc par `INFORMATION_SCHEMA` + `PREPARE`/`EXECUTE`, le motif employé par les
-- 038, 080 et 085.

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

-- Fin de l'ancienne table. Pas de rétro-compatibilité : deux jeux de réglages
-- jumeaux auraient dérivé dès la première évolution, et c'est exactement ce que
-- la 075 avait déjà refusé en supprimant `uptime_settings`.
SET @s = IF(@has_old_settings = 1, 'DROP TABLE notification_settings', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

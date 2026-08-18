-- Le rapprochement de fond des déploiements, et deux lignes de canaux de plus.
--
-- Trois sujets, un seul fichier parce qu'ils ne se comprennent qu'ensemble : le
-- suivi de fond n'a de valeur que s'il peut prévenir, et prévenir n'a de sens
-- qu'à condition de ne pas confondre « je découvre l'historique » avec « il
-- vient de se passer quelque chose ».
--
-- ## 1. `deploy_targets.synced_at`
--
-- Jusqu'ici, seuls les déploiements **déclenchés depuis DevEye** existaient en
-- base : `deploy.trigger` écrivait la ligne, et l'ordonnanceur ne réinterrogeait
-- que celles restées en vol. Un déploiement parti de l'interface de Dokploy,
-- d'une CI ou d'un push git n'avait donc aucune ligne, et n'apparaissait que
-- dans `deploy.history` — une requête vers l'instance, faite à l'ouverture d'une
-- fiche. En arrivant sur la page, on ne voyait rien.
--
-- La colonne porte le dernier rapprochement réussi, et deux rôles :
-- elle ordonne les cibles à réinterroger, et son `NULL` distingue le **premier**
-- rapprochement des suivants. Sans cette seconde lecture, l'import initial
-- enverrait un avis par ligne d'historique existante.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, JAMAIS via
-- `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la production au
-- démarrage (voir 038_uptime_order.sql).

SET @deploy_synced_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deploy_targets' AND COLUMN_NAME = 'synced_at');
SET @add_deploy_synced = IF(@deploy_synced_exists = 0,
    'ALTER TABLE deploy_targets ADD COLUMN synced_at BIGINT NULL AFTER content',
    'SELECT 1');
PREPARE stmt FROM @add_deploy_synced; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les cibles existantes partent à NULL, donc en premier import : leur historique
-- Dokploy entre en base sans réveiller personne. C'est le comportement voulu —
-- une cible déclarée l'an dernier ne doit pas produire cinquante avis au
-- redémarrage qui installe cette migration.

-- ## 2. `deployments.notified`
--
-- Même rôle que `uptime_incidents.notified`, et pour la même raison : un avis
-- appartient au **déploiement**, pas au tour de sondage qui l'a vu. Sans cette
-- colonne, chaque tour renotifierait le même échec tant que la ligne reste dans
-- la fenêtre lue.

SET @deploy_notified_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deployments' AND COLUMN_NAME = 'notified');
SET @add_deploy_notified = IF(@deploy_notified_exists = 0,
    'ALTER TABLE deployments ADD COLUMN notified TINYINT NOT NULL DEFAULT 0 AFTER finished_at',
    'SELECT 1');
PREPARE stmt FROM @add_deploy_notified; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Tout ce qui est **déjà terminé** est réputé notifié : ces déploiements ont eu
-- lieu avant que la feature sache prévenir, et en annoncer l'issue maintenant
-- serait un mensonge sur la date. Ce qui est encore en vol reste à 0 : celui-là
-- va réellement atterrir après la migration, et son issue est un fait nouveau.
--
-- Rejouable : ne touche que les lignes encore à 0 parmi les terminées, donc une
-- seconde exécution ne défait rien.
UPDATE deployments SET notified = 1 WHERE notified = 0 AND status IN ('success', 'failed');

-- Index de rapprochement. **Simple clé, pas une contrainte d'unicité** : le
-- rattachement par proximité de date qui existait avant cette migration a pu
-- coller le même `external_id` à deux lignes voisines, et une `UNIQUE KEY`
-- ferait alors échouer la migration au démarrage — sur une base de production,
-- pour une donnée d'affichage. L'unicité est portée par le rapprochement
-- applicatif, qui sait déjà traiter un `external_id` absent.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deployments' AND INDEX_NAME = 'idx_deployments_external');
SET @s = IF(@c = 0, 'ALTER TABLE deployments ADD KEY idx_deployments_external (target_id, external_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ## 3. Bases de données obtient ses propres canaux
--
-- `DatabaseMonitor` appelait `UptimeMonitor.resolveChannels` : un seuil SQL
-- franchi partait donc sur le salon désigné pour la disponibilité. C'était
-- documenté comme une économie — « mêmes destinataires, une seule configuration
-- à tenir à jour » — mais c'est mot pour mot le raisonnement que Sentinelle
-- avait suivi avant la 075, avec le même effet : impossible d'éteindre les
-- alertes de base sans éteindre Uptime, ni de les router ailleurs.
--
-- La reprise est **à l'identique**, comme la 075 l'avait fait pour Uptime :
-- recopier la ligne `uptime` dans `database` garantit que personne ne perd au
-- redémarrage une alerte qu'il recevait la veille. Les deux jeux divergent
-- ensuite librement. `INSERT IGNORE` rend l'étape rejouable et, surtout, ne
-- réécrit jamais une ligne `database` déjà réglée à la main.
INSERT IGNORE INTO notification_settings
    (workspace_id, feature, email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc)
SELECT workspace_id, 'database', email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc
FROM notification_settings WHERE feature = 'uptime';

-- Déploiement, lui, n'hérite de rien : ses avis n'existaient pas, personne n'en
-- attend, et les allumer d'office écrirait à des gens qui ne l'ont pas demandé —
-- le défaut que la 075 avait précisément corrigé. Sa ligne naîtra au premier
-- enregistrement dans le dialogue.

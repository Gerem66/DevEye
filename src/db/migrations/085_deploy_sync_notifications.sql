-- Le rapprochement de fond des déploiements, et deux lignes de canaux de plus.
--
-- ## 1. `deploy_targets.synced_at`
--
-- Seuls les déploiements déclenchés depuis DevEye existaient en base. La colonne
-- porte le dernier rapprochement réussi : elle ordonne les cibles à
-- réinterroger, et son `NULL` distingue le premier rapprochement des suivants
-- (l'import initial ne doit pas envoyer un avis par ligne d'historique).
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).

SET @deploy_synced_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deploy_targets' AND COLUMN_NAME = 'synced_at');
SET @add_deploy_synced = IF(@deploy_synced_exists = 0,
    'ALTER TABLE deploy_targets ADD COLUMN synced_at BIGINT NULL AFTER content',
    'SELECT 1');
PREPARE stmt FROM @add_deploy_synced; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les cibles existantes partent à NULL, donc en premier import : leur historique
-- Dokploy entre en base sans réveiller personne.

-- ## 2. `deployments.notified`
--
-- Même rôle que `uptime_incidents.notified` : un avis appartient au
-- déploiement, pas au tour de sondage qui l'a vu, sinon chaque tour
-- renotifierait le même échec.

SET @deploy_notified_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deployments' AND COLUMN_NAME = 'notified');
SET @add_deploy_notified = IF(@deploy_notified_exists = 0,
    'ALTER TABLE deployments ADD COLUMN notified TINYINT NOT NULL DEFAULT 0 AFTER finished_at',
    'SELECT 1');
PREPARE stmt FROM @add_deploy_notified; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Tout ce qui est déjà terminé est réputé notifié (annoncer l'issue maintenant
-- serait un mensonge sur la date). Ce qui est encore en vol reste à 0.
-- Rejouable : ne touche que les lignes encore à 0 parmi les terminées.
UPDATE deployments SET notified = 1 WHERE notified = 0 AND status IN ('success', 'failed');

-- Index de rapprochement. Simple clé, pas une contrainte d'unicité : le
-- rattachement par proximité de date a pu coller le même `external_id` à deux
-- lignes voisines, et une `UNIQUE KEY` ferait échouer la migration au démarrage.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deployments' AND INDEX_NAME = 'idx_deployments_external');
SET @s = IF(@c = 0, 'ALTER TABLE deployments ADD KEY idx_deployments_external (target_id, external_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ## 3. Bases de données obtient ses propres canaux
--
-- `DatabaseMonitor` empruntait les canaux d'Uptime : impossible d'éteindre les
-- alertes de base sans éteindre Uptime. Reprise à l'identique (comme 075) :
-- personne ne perd une alerte au redémarrage. `INSERT IGNORE` rend l'étape
-- rejouable et ne réécrit jamais une ligne `database` déjà réglée.
INSERT IGNORE INTO notification_settings
    (workspace_id, feature, email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc)
SELECT workspace_id, 'database', email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc
FROM notification_settings WHERE feature = 'uptime';

-- Déploiement n'hérite de rien : ses avis n'existaient pas, les allumer d'office
-- écrirait à des gens qui ne l'ont pas demandé.

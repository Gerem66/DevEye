-- Une seule duree de conservation par appareil.
--
-- La collecte est unifiee depuis 042 : un tick d'agent produit un *instant*
-- portant les metriques ET la liste des processus sous un seul horodatage. Les
-- durees de conservation, elles, etaient restees separees — au point que le
-- code annoncait 30 jours pour les processus pendant que `.env.prod` fixait
-- `PROCESS_RETENTION_DAYS=1`. `devices.retention_days` regit desormais les
-- trois tables filles, et la colonne dediee aux processus disparait.
--
-- L'historique repart de zero (decision produit). C'est ce qui permet de poser
-- au passage la cle unique et les index de purge sans dedoublonner quoi que ce
-- soit — voir chaque bloc pour la raison.
--
-- Les trois tables sont du cote *enfant* de leur cle etrangere vers `devices`
-- et ne sont referencees par personne : TRUNCATE y est autorise.

TRUNCATE TABLE device_process_samples;
TRUNCATE TABLE device_metrics;
TRUNCATE TABLE device_presence;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'process_retention_days');
SET @s = IF(@c > 0, 'ALTER TABLE devices DROP COLUMN process_retention_days', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Ingestion idempotente. `device_process_samples` a sa cle primaire
-- (device_id, ts) et son INSERT ... ON DUPLICATE KEY UPDATE ; `device_metrics`
-- n'avait qu'un index ordinaire et un INSERT nu, donc un lot rejoue par un
-- agent apres un accuse perdu dupliquait les points du graphe.
--
-- Le nouvel index est pose AVANT que l'ancien parte : `fk_metrics_device`
-- exige un index commencant par `device_id`, et celui-ci prend le relais.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_metrics' AND INDEX_NAME = 'uq_metrics_device_ts');
SET @s = IF(@c = 0, 'ALTER TABLE device_metrics ADD UNIQUE KEY uq_metrics_device_ts (device_id, ts)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_metrics' AND INDEX_NAME = 'idx_metrics_device_ts');
SET @s = IF(@c > 0, 'ALTER TABLE device_metrics DROP INDEX idx_metrics_device_ts', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Le balayage horaire filtre sur (pinned, ts) SANS device_id : tous les index
-- existants commencent par `device_id` et lui sont donc inutilisables, ce qui
-- lui faisait parcourir les tables entieres a chaque passage.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_metrics' AND INDEX_NAME = 'idx_metrics_prune');
SET @s = IF(@c = 0, 'ALTER TABLE device_metrics ADD KEY idx_metrics_prune (pinned, ts)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_presence' AND INDEX_NAME = 'idx_presence_ts');
SET @s = IF(@c = 0, 'ALTER TABLE device_presence ADD KEY idx_presence_ts (ts)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_process_samples' AND INDEX_NAME = 'idx_procsamples_prune');
SET @s = IF(@c = 0, 'ALTER TABLE device_process_samples ADD KEY idx_procsamples_prune (pinned, ts)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Taille du blob memorisee a l'insertion : `metrics.storage` sommait
-- LENGTH(payload) sur tous les blobs de l'appareil a chaque changement de
-- machine et apres chaque epinglage, ce qui lit chaque MEDIUMBLOB hors page.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_process_samples' AND COLUMN_NAME = 'payload_bytes');
SET @s = IF(@c = 0,
    'ALTER TABLE device_process_samples ADD COLUMN payload_bytes INT UNSIGNED NOT NULL AFTER proc_count',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

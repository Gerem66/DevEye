-- Le calendrier compte, par jour, les instants d'un appareil et ceux qui sont
-- epingles. Aucun index existant ne couvre `device_id + pinned` :
-- `uq_metrics_device_ts` est (device_id, ts) et `idx_metrics_prune` est
-- (pinned, ts), qui ne commence pas par l'appareil. Sans celui-ci, compter les
-- epingles d'un appareil lit une ligne par instant, soit la table entiere.
-- `device_process_samples` a deja son equivalent, `idx_procsamples_pinned`.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_metrics'
            AND INDEX_NAME = 'idx_metrics_device_pinned_ts');
SET @s = IF(@c = 0, 'ALTER TABLE device_metrics ADD KEY idx_metrics_device_pinned_ts (device_id, pinned, ts)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

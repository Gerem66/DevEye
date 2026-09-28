-- Les listes de processus completes de plus de deux jours sont reduites au top
-- par le balayage horaire d'Appareils. Cet index lui donne directement celles
-- qui restent, sans parcourir les instants deja reduits.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_process_samples' AND INDEX_NAME = 'idx_procsamples_thin');
SET @s = IF(@c = 0, 'ALTER TABLE device_process_samples ADD KEY idx_procsamples_thin (kind, pinned, ts)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

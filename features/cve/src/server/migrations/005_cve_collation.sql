-- Epingle la collation des tables de 001, creees sans COLLATE : elles ont pris
-- celle de la base, utf8mb4_0900_ai_ci sur un MySQL 8 neuf comme en production,
-- et leurs jointures avec ft_cve_products (epinglee) y echouent. Chaque geste
-- est garde par INFORMATION_SCHEMA et ne fait rien la ou c'est deja le cas.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_cve_entries' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE ft_cve_entries CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_cve_favorites' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE ft_cve_favorites CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_cve_state' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE ft_cve_state CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

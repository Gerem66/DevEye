-- La priorite aux abonnes, commune a tous les serveurs qui partagent la base
-- comme les pauses d'offre qu'elle commande. `priority_updated` et
-- `priority_by` disent quand et par qui, sans toucher a ceux du site.
--   UPDATE site_maintenance SET priority = 1
-- Conditionnel via INFORMATION_SCHEMA et SQL dynamique.
SET @site_priority_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'site_maintenance' AND COLUMN_NAME = 'priority'
);
SET @add_site_priority = IF(
    @site_priority_exists = 0,
    'ALTER TABLE site_maintenance
        ADD COLUMN priority TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN priority_updated BIGINT NULL,
        ADD COLUMN priority_by INT NULL,
        ADD CONSTRAINT fk_site_maintenance_priority_user FOREIGN KEY (priority_by) REFERENCES users (id) ON DELETE SET NULL',
    'SELECT 1'
);
PREPARE stmt FROM @add_site_priority;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

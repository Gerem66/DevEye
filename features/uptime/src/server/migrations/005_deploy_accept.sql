-- L'acceptation d'une nouvelle version apres un deploiement. Les sources d'un
-- service (projets, cibles de Deploiements, depots Git) ne sont que des
-- identifiants, comme les liaisons de Projets. L'adresse d'appel se retrouve
-- par le condensat de son jeton sans rien dechiffrer, et le jeton lui-meme,
-- chiffre a l'etage ouvert, se reaffiche a l'ecran. `integrity_pending_since`
-- date l'attente d'un deploiement en cours.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, refusee par MySQL).
CREATE TABLE IF NOT EXISTS ft_uptime_deploy_sources (
    service_id INT        NOT NULL,
    -- project, deploy ou git.
    kind       VARCHAR(8) NOT NULL,
    ref_id     INT        NOT NULL,
    position   INT        NOT NULL DEFAULT 0,
    PRIMARY KEY (service_id, kind, ref_id),
    CONSTRAINT fk_ft_uptime_deploy_sources_service FOREIGN KEY (service_id)
        REFERENCES uptime_services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'integrity_pending_since'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN integrity_pending_since BIGINT NULL AFTER integrity_verdict',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'deploy_hook_hash'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN deploy_hook_hash CHAR(64) NULL AFTER integrity_pending_since',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'deploy_hook_enc'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN deploy_hook_enc TEXT NULL AFTER deploy_hook_hash',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'deploy_hook_at'
);
SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN deploy_hook_at BIGINT NULL AFTER deploy_hook_enc',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND INDEX_NAME = 'uniq_uptime_services_deploy_hook'
);
SET @ddl = IF(
    @idx_exists = 0,
    'ALTER TABLE uptime_services ADD UNIQUE KEY uniq_uptime_services_deploy_hook (deploy_hook_hash)',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

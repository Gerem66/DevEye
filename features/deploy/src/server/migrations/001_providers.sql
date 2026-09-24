-- Les fournisseurs au-delà de Dokploy. Un accès dit son fournisseur (GitHub
-- n'a pas d'adresse d'instance). Une cible sur une machine vise un appareil au
-- lieu d'un accès, unique par espace, appareil et identifiant. `external_id`
-- s'élargit : propriétaire/dépôt#workflow dépasse 128 caractères.
--
-- Rejouable : chaque ajout est gardé par l'état lu dans INFORMATION_SCHEMA,
-- jamais par ADD COLUMN IF NOT EXISTS (extension MariaDB).

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND COLUMN_NAME = 'provider');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD COLUMN provider VARCHAR(16) NOT NULL DEFAULT ''dokploy'' AFTER workspace_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE deploy_targets MODIFY external_id VARCHAR(255) NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deploy_targets' AND COLUMN_NAME = 'device_id');
SET @s = IF(@c = 0,
    'ALTER TABLE deploy_targets ADD COLUMN device_id CHAR(36) NULL AFTER credential_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deploy_targets'
             AND CONSTRAINT_NAME = 'fk_deploy_target_device');
SET @s = IF(@c = 0,
    'ALTER TABLE deploy_targets ADD CONSTRAINT fk_deploy_target_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deploy_targets'
             AND CONSTRAINT_NAME = 'uniq_deploy_target_device');
SET @s = IF(@c = 0,
    'ALTER TABLE deploy_targets ADD UNIQUE KEY uniq_deploy_target_device (workspace_id, device_id, external_id)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

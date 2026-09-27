-- Un appareil revoque devient un appareil archive : meme refus a la socket,
-- jeton efface, retour par un nouvel appairage. Une suppression en attente sur
-- un appareil revoque ne pouvait pas aboutir (l'agent refuse ne recevait
-- jamais l'ordre de s'effacer), elle s'archive de la meme facon.
UPDATE devices
   SET status = 'archived', token_hash = '', token_hash_prev = NULL,
       status_before_delete = NULL, delete_error = NULL
 WHERE status = 'revoked' OR status_before_delete = 'revoked';

-- Lier une machine neuve la rend active : un code n'a plus rien a approuver
-- d'office. Conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `DROP COLUMN IF EXISTS` (extension MariaDB, refusee par MySQL).
SET @link_code_auto_approve_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_link_codes' AND COLUMN_NAME = 'auto_approve'
);
SET @drop_link_code_auto_approve = IF(
    @link_code_auto_approve_exists > 0,
    'ALTER TABLE device_link_codes DROP COLUMN auto_approve',
    'SELECT 1'
);
PREPARE stmt FROM @drop_link_code_auto_approve;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Un code vaut une heure au plus et expire toujours : ceux emis plus longs ou
-- sans echeance sont ramenes au plafond, un code consomme sans echeance prend
-- sa date d'usage.
UPDATE device_link_codes
   SET expires_at = UNIX_TIMESTAMP() + 3600
 WHERE used_at IS NULL AND (expires_at IS NULL OR expires_at > UNIX_TIMESTAMP() + 3600);
UPDATE device_link_codes SET expires_at = COALESCE(used_at, created) WHERE expires_at IS NULL;
ALTER TABLE device_link_codes MODIFY COLUMN expires_at BIGINT NOT NULL;

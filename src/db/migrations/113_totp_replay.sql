-- Compteur du dernier code TOTP accepté : un code ne se rejoue pas dans sa
-- fenêtre, et deux soumissions simultanées du même code n'en valident qu'une
-- (la mise à jour est conditionnelle, voir `twoFactorRepo.claimTotpCounter`).
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique : `ADD COLUMN IF
-- NOT EXISTS` est une extension MariaDB, refusée par MySQL.
SET @last_used_counter_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_2fa' AND COLUMN_NAME = 'last_used_counter'
);
SET @add_last_used_counter = IF(
    @last_used_counter_exists = 0,
    'ALTER TABLE user_2fa ADD COLUMN last_used_counter BIGINT NULL AFTER confirmed_at',
    'SELECT 1'
);
PREPARE stmt FROM @add_last_used_counter;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

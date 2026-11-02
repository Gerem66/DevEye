-- CloudSync : un partage qui refuse ses dossiers sensibles signale chaque
-- fichier qu'un appareil ne peut pas recevoir. À 0, ce refus est voulu, et le
-- serveur cesse d'y écrire sans plus le signaler. Ajout conditionnel via
-- INFORMATION_SCHEMA.
SET @ss_report_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND COLUMN_NAME = 'sensitive_report');
SET @add_ss_report = IF(@ss_report_exists = 0,
    'ALTER TABLE sync_shares ADD COLUMN sensitive_report TINYINT NOT NULL DEFAULT 1 AFTER sensitive_writes',
    'SELECT 1');
PREPARE stmt FROM @add_ss_report; EXECUTE stmt; DEALLOCATE PREPARE stmt;

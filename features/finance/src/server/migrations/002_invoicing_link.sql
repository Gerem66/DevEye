-- Les règlements de Facturation recopiés dans le livre, le compte qui les
-- reçoit, et le jour où le solde de départ d'un compte a été relevé : rien
-- d'antérieur n'est recopié, puisque ce solde le compte déjà. La devise et le
-- régime de TVA quittent le livre : Facturation les tient, Finances les lit.
--
-- Rejouable : chaque changement de structure est gardé par la lecture
-- d'INFORMATION_SCHEMA.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'finance_transactions'
              AND COLUMN_NAME = 'source');
SET @s = IF(@has = 0,
    'ALTER TABLE finance_transactions ADD COLUMN source VARCHAR(16) NULL AFTER recurring_id, ADD COLUMN source_ref VARCHAR(40) NULL AFTER source, ADD UNIQUE KEY uniq_finance_tx_source (workspace_id, source, source_ref)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'finance_accounts'
              AND COLUMN_NAME = 'opened_on');
SET @s = IF(@has = 0,
    'ALTER TABLE finance_accounts ADD COLUMN opened_on DATE NULL AFTER initial_balance',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Un compte déjà ouvert part de sa première opération, ou à défaut du jour de sa création.
UPDATE finance_accounts a
   SET a.opened_on = COALESCE(
           (SELECT MIN(t.date) FROM finance_transactions t
             WHERE t.account_id = a.id OR t.transfer_account_id = a.id),
           DATE(FROM_UNIXTIME(a.created)))
 WHERE a.opened_on IS NULL;

ALTER TABLE finance_accounts MODIFY COLUMN opened_on DATE NOT NULL;

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'finance_config'
              AND COLUMN_NAME = 'invoicing_account_id');
SET @s = IF(@has = 0,
    'ALTER TABLE finance_config ADD COLUMN invoicing_account_id INT NULL, ADD COLUMN invoicing_category_id INT NULL, ADD COLUMN invoicing_version VARCHAR(120) NULL, ADD CONSTRAINT fk_fin_config_inv_account FOREIGN KEY (invoicing_account_id) REFERENCES finance_accounts (id) ON DELETE SET NULL, ADD CONSTRAINT fk_fin_config_inv_category FOREIGN KEY (invoicing_category_id) REFERENCES finance_categories (id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'finance_config'
              AND COLUMN_NAME = 'currency');
SET @s = IF(@has = 1,
    'ALTER TABLE finance_config DROP COLUMN currency, DROP COLUMN vat_enabled',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

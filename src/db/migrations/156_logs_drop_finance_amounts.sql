-- Le journal d'audit ne garde pas le montant d'une opération de Finances : les
-- lignes qui le portaient le perdent.
--
-- Rejouable : une ligne sans la clé n'est pas touchée.

UPDATE logs
   SET metadata = JSON_REMOVE(metadata, '$.amount')
 WHERE action IN ('finance.transactionAdd', 'finance.recurringPost')
   AND JSON_CONTAINS_PATH(metadata, 'one', '$.amount');

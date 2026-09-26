-- Le miroir destructif de `migrations/`, borné au préfixe du module, les
-- enfants d'abord. Les tables nées dans le socle (`finance_*`) ne s'en vont pas
-- avec lui.
DROP TABLE IF EXISTS ft_finance_statement_lines;
DROP TABLE IF EXISTS ft_finance_imports;
DROP TABLE IF EXISTS ft_finance_rules;
DROP TABLE IF EXISTS ft_finance_reminders;

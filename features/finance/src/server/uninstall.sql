-- Le miroir destructif de `migrations/`, borné au préfixe du module. Les tables
-- nées dans le socle (`finance_*`) ne s'en vont pas avec lui.
DROP TABLE IF EXISTS ft_finance_reminders;

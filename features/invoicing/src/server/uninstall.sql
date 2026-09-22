-- Le miroir destructif de `migrations/` (les deux), borné au préfixe du module.
-- Les enfants d'abord : les clés étrangères refuseraient l'inverse.
DROP TABLE IF EXISTS ft_invoicing_deductions;
DROP TABLE IF EXISTS ft_invoicing_payments;
DROP TABLE IF EXISTS ft_invoicing_lines;
DROP TABLE IF EXISTS ft_invoicing_docs;
DROP TABLE IF EXISTS ft_invoicing_clients;
DROP TABLE IF EXISTS ft_invoicing_settings;

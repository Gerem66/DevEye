-- Finances tient la trésorerie d'une activité : les budgets par catégorie
-- sont retirés, et un compte est courant, d'épargne, de caisse ou autre.
DROP TABLE IF EXISTS finance_budgets;

UPDATE finance_accounts SET kind = 'checking' WHERE kind IN ('card', 'business');

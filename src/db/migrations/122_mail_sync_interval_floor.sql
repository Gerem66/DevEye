-- Le plancher de la cadence de releve passe a 5 minutes. Les comptes regles
-- plus bas gardaient une valeur que l'ecran ne sait plus produire ni revalider.

UPDATE mail_accounts SET sync_interval_seconds = 300 WHERE sync_interval_seconds < 300;

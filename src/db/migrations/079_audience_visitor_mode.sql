-- Comment un visiteur est reconnu, site par site : 'anonymous' (défaut, cf.
-- 076 : condensé IP + user-agent + sel du jour, rien n'est écrit chez le
-- visiteur) ou 'persistent' (identifiant rangé dans le stockage du navigateur,
-- la personne est reconnue d'un jour à l'autre). Ce second mode relève du
-- consentement (ePrivacy), d'où le défaut 'anonymous'.
-- En clair : l'ingestion s'en sert sans session ni clé.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'visitor_mode');
SET @s = IF(@c = 0,
    'ALTER TABLE audience_sites ADD COLUMN visitor_mode VARCHAR(12) NOT NULL DEFAULT ''anonymous'' AFTER platform',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Comment un visiteur est reconnu, site par site.
--
-- 'anonymous' (défaut, comportement de la migration 076) : un condensé de l'IP,
-- du user-agent et d'un sel qui tourne chaque jour. Rien n'est écrit chez le
-- visiteur, donc rien à faire accepter, et une même personne revenant le
-- lendemain compte pour une nouvelle.
--
-- 'persistent' : le site range un identifiant tiré au sort dans le stockage du
-- navigateur et le renvoie à chaque mesure. La personne est alors reconnue d'un
-- jour à l'autre, ce qui rend les visiteurs connus mesurables.
--
-- ⚠️ Ce mode relève du consentement : un identifiant durable, cookie ou
-- localStorage, tombe sous ePrivacy de la même façon. Le défaut reste donc
-- 'anonymous', et le passage est un geste explicite.
--
-- En clair, comme la clé publique et les origines : l'ingestion s'en sert pour
-- décider quoi faire d'un identifiant reçu, sans session ni clé de chiffrement.
--
-- Motif `INFORMATION_SCHEMA` + `PREPARE` obligatoire : `ADD COLUMN IF NOT
-- EXISTS` est de la syntaxe MariaDB et a déjà fait tomber la production une
-- fois (voir 038_uptime_order.sql).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'visitor_mode');
SET @s = IF(@c = 0,
    'ALTER TABLE audience_sites ADD COLUMN visitor_mode VARCHAR(12) NOT NULL DEFAULT ''anonymous'' AFTER platform',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les retours se déclarent, et les origines disent enfin trois choses.
--
-- Deux corrections de la première version (001), toutes deux sur le même
-- défaut : le réglage par défaut y était le plus permissif.
--
-- 1. Un formulaire naissait de sa première réception. Qui lit la clé publique
--    dans la page pouvait donc faire apparaître vingt canaux et autant de
--    colonnes. Un formulaire se déclare désormais, avec ses champs et leur
--    type. Le mode « auto » reste offert, mais il faut le vouloir.
-- 2. Une liste d'origines vide acceptait TOUT. Elle n'accepte plus rien, et
--    c'est « * » qui ouvre la porte. La mise à jour du bas préserve le
--    comportement des sites déjà branchés, en l'écrivant au lieu de le
--    supposer.
--
-- Ajouts conditionnels via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038 et 079).

-- 'strict' | 'auto'. Défaut 'auto' parce que cette colonne s'ajoute à des
-- lignes existantes, créées quand tout était accepté : les basculer en strict
-- sans schéma les rendrait muettes du jour au lendemain. Le défaut du PRODUIT
-- est strict, et c'est le handler de création qui le pose.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_audience_forms' AND COLUMN_NAME = 'mode');
SET @s = IF(@c = 0, 'ALTER TABLE ft_audience_forms ADD COLUMN mode VARCHAR(6) NOT NULL DEFAULT ''auto'' AFTER name_ref', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- { fields } chiffré : le nom d'une question et ses réponses possibles sont du
-- contenu utilisateur. NULL en mode auto, où il n'y a rien de déclaré.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_audience_forms' AND COLUMN_NAME = 'form_schema');
SET @s = IF(@c = 0, 'ALTER TABLE ft_audience_forms ADD COLUMN form_schema TEXT NULL AFTER mode', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Quand la fermeture automatique est tombée. Une fermeture datée et réversible
-- borne une rafale dans le temps, là où le plafond de stockage seul
-- condamnerait le formulaire jusqu'à ce qu'on le vide à la main.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_audience_forms' AND COLUMN_NAME = 'closed_at');
SET @s = IF(@c = 0, 'ALTER TABLE ft_audience_forms ADD COLUMN closed_at BIGINT NULL AFTER is_open', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 'quota' | 'full'. NULL quand c'est un geste humain : l'écran ne raconte une
-- rafale que s'il y en a eu une.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_audience_forms' AND COLUMN_NAME = 'closed_reason');
SET @s = IF(@c = 0, 'ALTER TABLE ft_audience_forms ADD COLUMN closed_reason VARCHAR(16) NULL AFTER closed_at', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Condensé de l'adresse avec le sel du jour, comme visitor_ref : de quoi
-- compter les envois d'une même provenance sur une heure sans conserver une
-- seule adresse. Les lignes d'avant portent '', elles ne comptent pour personne.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_audience_submissions' AND COLUMN_NAME = 'ip_ref');
SET @s = IF(@c = 0, 'ALTER TABLE ft_audience_submissions ADD COLUMN ip_ref CHAR(16) NOT NULL DEFAULT '''' AFTER ts', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Accepter un nom de formulaire jamais déclaré, et le créer. Éteint par défaut,
-- y compris sur les sites existants : c'est le réglage qui prête l'interface à
-- qui lit la clé publique dans la page.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'forms_auto');
SET @s = IF(@c = 0, 'ALTER TABLE audience_sites ADD COLUMN forms_auto TINYINT NOT NULL DEFAULT 0 AFTER retention_days', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Retours acceptés d'une même adresse vers un même formulaire, par heure.
-- Personne n'envoie six messages de contact en une heure.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'submission_ip_quota');
SET @s = IF(@c = 0, 'ALTER TABLE audience_sites ADD COLUMN submission_ip_quota INT NOT NULL DEFAULT 5 AFTER forms_auto', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Retours par heure et par formulaire, toutes adresses confondues. Dépassé, le
-- formulaire se ferme : c'est la borne contre une rafale distribuée.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'form_hourly_quota');
SET @s = IF(@c = 0, 'ALTER TABLE audience_sites ADD COLUMN form_hourly_quota INT NOT NULL DEFAULT 200 AFTER submission_ip_quota', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Événements de mesure par adresse et par heure. 0 = illimité, et c'est le
-- défaut : aucun site déjà branché ne doit se mettre à perdre des vues sans
-- qu'on l'ait demandé. Compté en mémoire, jamais en SQL (chemin chaud).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'event_ip_quota');
SET @s = IF(@c = 0, 'ALTER TABLE audience_sites ADD COLUMN event_ip_quota INT NOT NULL DEFAULT 0 AFTER form_hourly_quota', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Le quota par adresse se lit sur une fenêtre glissante, comme le plafond
-- horaire des signalements du socle : un COUNT(*) servi par un index composite,
-- aucune table de compteurs, rien à purger.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_audience_submissions'
            AND INDEX_NAME = 'idx_ft_audience_submissions_ip');
SET @s = IF(@c = 0,
    'CREATE INDEX idx_ft_audience_submissions_ip ON ft_audience_submissions (form_id, ip_ref, ts)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les sites déjà branchés sans origine déclarée continuent exactement comme
-- avant, mais parce que c'est écrit et relisible dans leurs réglages. Sans
-- cette ligne, ils cesseraient tous de mesurer au déploiement, en silence.
UPDATE audience_sites SET origins = '*' WHERE origins IS NULL OR TRIM(origins) = '';

-- Un signalement n'est plus supprimé au bout de sa durée ni avec son compte :
-- il est anonymisé. Le message, l'auteur, l'adresse et ce que le navigateur dit
-- de la personne partent, sa partie technique reste pour suivre les problèmes
-- sur des années. Cette date dit qu'il l'a été.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB).
SET @feedback_anonymized_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback' AND COLUMN_NAME = 'anonymized_at');
SET @add_feedback_anonymized = IF(@feedback_anonymized_exists = 0,
    'ALTER TABLE feedback ADD COLUMN anonymized_at BIGINT NULL AFTER handled_by',
    'SELECT 1');
PREPARE stmt FROM @add_feedback_anonymized; EXECUTE stmt; DEALLOCATE PREPARE stmt;

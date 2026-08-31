-- Le vecteur CVSS s'allonge avec la v4.0 : 44 caracteres en v3.1, mais jusqu'a
-- pres de 200 quand les metriques facultatives sont toutes portees. La colonne
-- taillee pour la v3.1 refusait ces lignes-la, et le refus emportait toute la
-- recherche qui les avait ramenees.
--
-- Rejouable : la modification est gardee par la lecture d'INFORMATION_SCHEMA.

SET @len = (SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'ft_cve_entries'
              AND COLUMN_NAME = 'vector');

SET @s = IF(@len IS NOT NULL AND @len < 320,
    'ALTER TABLE ft_cve_entries MODIFY COLUMN vector VARCHAR(320) NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

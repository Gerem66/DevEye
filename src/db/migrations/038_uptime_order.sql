-- Ordre des services surveillés entièrement défini par l'utilisateur
-- (glisser-déposer), comme pour les notes. Rien ne touche `sort_order` en dehors
-- de `uptime.reorder` et de l'ajout d'un service (rang suivant, donc la fin).
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, PAS via
-- `ADD COLUMN IF NOT EXISTS` : cette clause est une extension MariaDB, refusée
-- par MySQL, et a fait tomber la production au démarrage.
SET @sort_order_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'sort_order'
);
SET @add_sort_order = IF(
    @sort_order_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER enabled',
    'SELECT 1'
);
PREPARE stmt FROM @add_sort_order;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Rang initial = l'ordre de création par (utilisateur, workspace), ce que la
-- liste affichait jusqu'ici. Restreint aux rangs encore à zéro : une disposition
-- déjà posée à la main n'est pas réécrasée.
UPDATE uptime_services s
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, workspace_id ORDER BY id ASC) - 1 AS rn
    FROM uptime_services
) ranked ON ranked.id = s.id
SET s.sort_order = ranked.rn
WHERE s.sort_order = 0;

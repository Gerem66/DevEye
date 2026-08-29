-- Ordre des appareils entièrement défini par l'utilisateur (glisser-déposer).
-- Rien ne touche `sort_order` en dehors de `device.reorder` et de la liaison
-- d'un appareil, qui prend le rang suivant. Portée : l'espace. La page
-- Appareils (flotte entière) garde son tri par date.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).
SET @device_sort_order_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'sort_order'
);
SET @add_device_sort_order = IF(
    @device_sort_order_exists = 0,
    'ALTER TABLE devices ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER status',
    'SELECT 1'
);
PREPARE stmt FROM @add_device_sort_order;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Rang initial = l'ordre qu'affichait la liste (du plus récemment lié au plus
-- ancien). Restreint aux rangs encore à zéro, pour ne pas réécraser une
-- disposition déjà posée à la main.
UPDATE devices d
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created DESC, id ASC) - 1 AS rn
    FROM devices
) ranked ON ranked.id = d.id
SET d.sort_order = ranked.rn
WHERE d.sort_order = 0;

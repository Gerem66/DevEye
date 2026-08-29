-- L'épinglage de la preuve devient un réglage, appareil par appareil.
--
-- Un constat de gravité haute ou critique épingle l'instant qui le porte, pour
-- que la retention n'efface pas la seule liste de processus qui l'explique. Ces
-- instants apparaissent dans l'historique de Monitoring comme des snapshots
-- gardes, sans que rien ne dise d'ou ils viennent ni comment les refuser.
--
-- Actif par defaut : c'est le comportement en place, et un constat sans sa
-- preuve ne vaut pas grand-chose.
--
-- Rejouable : l'ajout est garde par la lecture d'INFORMATION_SCHEMA.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'ft_sentinel_device_config'
            AND COLUMN_NAME = 'pin_evidence');

SET @s = IF(@c = 0,
    'ALTER TABLE ft_sentinel_device_config
        ADD COLUMN pin_evidence TINYINT NOT NULL DEFAULT 1 AFTER auth_events',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

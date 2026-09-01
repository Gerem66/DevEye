-- Une restriction par élément devient une SURCHARGE. Elle n'abaissait que ; elle
-- peut désormais aussi ouvrir : accorder l'écriture, ou une permission propre,
-- sur un élément précis à un rôle qui ne l'a pas ailleurs. Le plancher reste la
-- lecture sur la fonctionnalité, sans quoi l'élément n'existe pas pour le rôle.
--
-- `denied_extras` (tableau de clés refusées) devient donc `extra_overrides`
-- (objet clé -> booléen, `false` retire, `true` accorde). Les lignes existantes
-- se convertissent : chaque clé refusée devient une entrée à `false`.
--
-- Rejouable : la conversion est gardée par la présence de l'ancienne colonne, et
-- chaque ajout par la lecture d'INFORMATION_SCHEMA.

SET @old = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_role_grants'
              AND COLUMN_NAME = 'denied_extras');
SET @new = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_role_grants'
              AND COLUMN_NAME = 'extra_overrides');

SET @s = IF(@new = 0,
    'ALTER TABLE item_role_grants ADD COLUMN extra_overrides JSON NULL AFTER access',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- JSON_OBJECTAGG sur les éléments du tableau : chaque clé refusée passe à false.
-- Une ligne au tableau vide devient NULL, l'absence valant « rien de particulier ».
SET @s = IF(@old > 0,
    'UPDATE item_role_grants g
        JOIN (SELECT g2.workspace_id, g2.feature, g2.item_id, g2.role_id,
                     JSON_OBJECTAGG(jt.k, FALSE) AS built
                FROM item_role_grants g2
                JOIN JSON_TABLE(g2.denied_extras, ''$[*]'' COLUMNS (k VARCHAR(24) PATH ''$'')) jt
               WHERE JSON_LENGTH(g2.denied_extras) > 0
               GROUP BY g2.workspace_id, g2.feature, g2.item_id, g2.role_id) c
          ON c.workspace_id = g.workspace_id AND c.feature = g.feature
         AND c.item_id = g.item_id AND c.role_id = g.role_id
         SET g.extra_overrides = c.built',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@old > 0, 'ALTER TABLE item_role_grants DROP COLUMN denied_extras', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Une ligne sans surcharge d'aucune sorte n'a pas lieu d'être : l'absence est ce
-- qui exprime « comme la fonctionnalité ».
DELETE FROM item_role_grants
 WHERE access IS NULL AND (extra_overrides IS NULL OR JSON_LENGTH(extra_overrides) = 0);

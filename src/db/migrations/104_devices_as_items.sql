-- Un appareil devient un élément comme un autre : son domicile est l'espace où
-- il a été appairé, et il se voit ailleurs par la projection commune
-- (`item_shares`), avec les restrictions par rôle qui vont avec. La jonction
-- `device_workspaces`, adhésion maison antérieure au partage d'éléments,
-- disparaît.

-- 1. Le rang chez soi revient sur la ligne, comme la table de toute feature ;
--    celui des espaces qui ne font que voir l'appareil part dans `item_shares`.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'sort_order');
SET @s = IF(@c = 0, 'ALTER TABLE devices ADD COLUMN sort_order INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE devices d
JOIN device_workspaces dw ON dw.device_id = d.id AND dw.workspace_id = d.workspace_id
SET d.sort_order = dw.sort_order;

-- 2. Chaque adhésion qui n'est pas le domicile devient une projection.
INSERT IGNORE INTO item_shares
    (workspace_id, feature, item_id, home_workspace_id, shared_by_user_id, created, sort_order)
SELECT dw.workspace_id, 'devices', dw.device_id, d.workspace_id, d.owner_id,
       UNIX_TIMESTAMP(), dw.sort_order
  FROM device_workspaces dw
  JOIN devices d ON d.id = dw.device_id
 WHERE d.workspace_id IS NOT NULL AND dw.workspace_id <> d.workspace_id;

DROP TABLE device_workspaces;

-- 3. Le domicile redevient obligatoire. Un appareil qui n'en a plus (espace
--    d'appairage supprimé, `ON DELETE SET NULL` posé par 072) ne relève de
--    personne : ses relevés partent avec lui.
DELETE FROM devices WHERE workspace_id IS NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
            AND CONSTRAINT_NAME = 'fk_device_workspace');
SET @s = IF(@c > 0, 'ALTER TABLE devices DROP FOREIGN KEY fk_device_workspace', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE devices MODIFY COLUMN workspace_id INT NOT NULL;

-- L'espace supprimé emporte ses appareils, et `item_shares` ses projections
-- (`fk_item_share_home`). `uniq_workspace_fingerprint` reste : c'est la clé du
-- ré-enrôlement, qui doit retrouver la ligne de l'espace visé.
ALTER TABLE devices ADD CONSTRAINT fk_device_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

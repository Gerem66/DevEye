-- Un appareil peut etre partage entre plusieurs espaces : la frontiere d'acces
-- devient la table de jonction `device_workspaces`.
--
-- `devices.workspace_id` est CONSERVE : il reste l'espace d'appairage, porte
-- `uniq_workspace_fingerprint` et sert `findByWorkspaceFingerprint` lors du
-- re-enrolement (route publique, sans session). Rendre `fingerprint`
-- globalement unique laisserait n'importe quel detenteur d'un code de liaison
-- se rattacher a un appareil existant en devinant son empreinte.

CREATE TABLE IF NOT EXISTS device_workspaces (
    device_id    CHAR(36) NOT NULL,
    workspace_id INT      NOT NULL,
    -- Le rang est propre a chaque espace : la meme machine se range
    -- independamment dans chaque liste qui l'affiche.
    sort_order   INT      NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, workspace_id),
    KEY idx_devws_workspace (workspace_id, sort_order),
    CONSTRAINT fk_devws_device    FOREIGN KEY (device_id)    REFERENCES devices(id)    ON DELETE CASCADE,
    CONSTRAINT fk_devws_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Reprise de l'existant : chaque appareil est partage avec son espace
-- d'appairage, en conservant le rang qu'il y avait.
INSERT IGNORE INTO device_workspaces (device_id, workspace_id, sort_order)
SELECT id, workspace_id, sort_order FROM devices WHERE workspace_id IS NOT NULL;

-- Le rang n'a plus de sens sur la ligne appareil : il vit dans la jonction.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'sort_order');
SET @s = IF(@c > 0, 'ALTER TABLE devices DROP COLUMN sort_order', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- `fk_device_workspace` passe de CASCADE a SET NULL : supprimer un espace ne
-- doit plus emporter un appareil partage ailleurs. L'appareil perd son origine,
-- pas son existence, et reste joignable par les espaces de la jonction.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
            AND CONSTRAINT_NAME = 'fk_device_workspace');
SET @s = IF(@c > 0, 'ALTER TABLE devices DROP FOREIGN KEY fk_device_workspace', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE devices MODIFY COLUMN workspace_id INT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
            AND CONSTRAINT_NAME = 'fk_device_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE devices ADD CONSTRAINT fk_device_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- `monitoring` n'est plus un droit d'espace accordable (la carte d'agregat est
-- reservee a l'administrateur global) : on retire la valeur des roles existants.
-- JSON_SEARCH rend le chemin de l'entree (`$[2].feature`), dont on retire le
-- suffixe pour viser l'element entier. Une entree au plus par role.
UPDATE workspace_roles
   SET features = JSON_REMOVE(
         features,
         TRIM(TRAILING '.feature' FROM JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'monitoring', NULL, '$[*].feature')))
       )
 WHERE JSON_SEARCH(features, 'one', 'monitoring', NULL, '$[*].feature') IS NOT NULL;

-- Le magasin clé-valeur des modules de features : une ligne par (espace,
-- feature, clé), avec le mode de protection FIGÉ SUR LA LIGNE ('server' =
-- étage ouvert, 'private' = étage gardé, 'none' = clair). Le mode voyage avec
-- la valeur parce que c'est la lecture qui doit choisir le bon déchiffrement.
-- `feature` est un VARCHAR et non un enum : la liste des modules dépend de
-- l'installation, pas du schéma.
-- Rejouable : création sous garde d'existence.

SET @has_table = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_kv');

SET @s = IF(@has_table = 0,
    "CREATE TABLE feature_kv (
        workspace_id INT NOT NULL,
        feature VARCHAR(32) NOT NULL,
        k VARCHAR(128) NOT NULL,
        mode ENUM('server', 'private', 'none') NOT NULL DEFAULT 'server',
        value MEDIUMTEXT NOT NULL,
        updated BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, feature, k),
        CONSTRAINT fk_feature_kv_workspace FOREIGN KEY (workspace_id)
            REFERENCES workspaces (id) ON DELETE CASCADE
    )",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

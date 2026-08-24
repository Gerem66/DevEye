-- Le magasin clé-valeur des modules de features.
--
-- Un module tiers persiste sans déclarer de table : une ligne par
-- (espace, feature, clé), avec le mode de protection FIGÉ SUR LA LIGNE
-- ('server' = étage ouvert, 'private' = étage gardé, 'none' = clair). Le mode
-- voyage avec la valeur parce que c'est la lecture qui doit choisir le bon
-- déchiffrement : le déclarer à part, c'est garantir qu'un jour une ligne se
-- lira avec la mauvaise clé. Les données relationnelles d'un module vont dans
-- ses propres tables `ft_<slug>_*` ; ce magasin ne porte que le simple.
--
-- `feature` est un VARCHAR et non un enum SQL : la liste des modules dépend de
-- l'installation, pas du schéma. `k` est bornée court exprès, une clé est un
-- nom, pas un document.
--
-- ## Rejouabilité
--
-- Une seule création, sous garde d'existence.

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

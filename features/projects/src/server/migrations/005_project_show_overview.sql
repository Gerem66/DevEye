-- L'onglet Vue d'ensemble parait-il dans la barre de ce projet ? Attribut du
-- PROJET et non de son lecteur : deux membres voient la meme barre, comme ils
-- voient le meme tableau.
--
-- En clair, a cote de `status` et `security_tier` : la barre d'onglets se
-- dessine avant tout dechiffrement, et un projet confidentiel verrouille doit
-- pouvoir s'ouvrir sur son Tableau sans reclamer de mot de passe.
--
-- Rejouable : l'ajout est garde par la lecture d'INFORMATION_SCHEMA.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'projects'
              AND COLUMN_NAME = 'show_overview');

SET @s = IF(@has = 0,
    'ALTER TABLE projects ADD COLUMN show_overview TINYINT NOT NULL DEFAULT 1 AFTER version_source',
    'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

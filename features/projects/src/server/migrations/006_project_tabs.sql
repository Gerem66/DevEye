-- La barre d'onglets d'un projet se resserre : le Tableau est la seule vue
-- obligatoire et celle d'arrivee, la Vue d'ensemble et la Frise se declarent.
--
-- La Vue d'ensemble s'efface par defaut : elle resume, elle ne fait pas
-- travailler, et un projet neuf n'a rien a y montrer. Les projets existants la
-- perdent aussi : le drapeau naissait a 1 dans la meme livraison que celle-ci,
-- personne n'a donc encore choisi de la garder.
--
-- La Frise, elle, arrive a 1 : elle etait obligatoire jusqu'ici, et la
-- reconduire est ce qui ne change rien pour les projets deja dates.
--
-- Rejouable : l'ajout de colonne est garde par INFORMATION_SCHEMA, et poser
-- deux fois le meme defaut ne fait rien. La remise a zero, elle, ne vise que
-- les lignes d'avant cette migration, qui n'existent plus au second passage.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'projects'
              AND COLUMN_NAME = 'show_timeline');

SET @s = IF(@has = 0,
    'ALTER TABLE projects ADD COLUMN show_timeline TINYINT NOT NULL DEFAULT 1 AFTER show_overview',
    'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @reset = IF(@has = 0, 'UPDATE projects SET show_overview = 0', 'SELECT 1');
PREPARE stmt FROM @reset;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE projects MODIFY show_overview TINYINT NOT NULL DEFAULT 0;

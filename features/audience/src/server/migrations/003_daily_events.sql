-- Le total des evenements du jour, vues et evenements nommes confondus : c'est
-- ce que l'offre du compte borne. `views` ne compte que les vues, un site qui
-- n'enverrait que des evenements nommes echappait donc a toute limite.
--
-- Rejouable : l'ajout est garde par la lecture d'INFORMATION_SCHEMA. Les jours
-- deja agreges partent de leurs vues, le minimum certain. Le menage horaire
-- recalcule hier et aujourd'hui avec le vrai total.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'audience_daily'
              AND COLUMN_NAME = 'events');

SET @s = IF(@has = 0,
    'ALTER TABLE audience_daily ADD COLUMN events INT NOT NULL DEFAULT 0 AFTER views',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE audience_daily SET events = views WHERE events < views;

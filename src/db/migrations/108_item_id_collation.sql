-- L'identifiant d'un élément projeté se compare à la clé de la table de sa
-- feature. Celle des appareils est la seule de type texte, et cette comparaison
-- joint deux collations : `item_shares` et `item_role_grants` épinglent
-- `utf8mb4_general_ci` (089), quand `devices` hérite du défaut de la base (004).
-- Sur un serveur dont le défaut diffère (`utf8mb4_0900_ai_ci` sous MySQL 8), la
-- jointure lève « Illegal mix of collations » et plus aucune lecture d'appareil
-- n'aboutit. Les deux colonnes prennent donc la collation effective de
-- `devices.id`, quelle qu'elle soit.
--
-- Dans ce sens et pas l'autre : `devices.id` est référencée par les tables
-- d'historique, en changer la collation imposerait de convertir chaque colonne
-- fille. Rien ne référence ces deux tables.
--
-- Rejouable, et sans effet là où les collations coïncident déjà.

SET @cs = (SELECT CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'id');
SET @coll = (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'id');

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_shares'
             AND COLUMN_NAME = 'item_id' AND COLLATION_NAME <> @coll);
SET @s = IF(@c = 1, CONCAT('ALTER TABLE item_shares MODIFY COLUMN item_id VARCHAR(64) ',
                           'CHARACTER SET ', @cs, ' COLLATE ', @coll, ' NOT NULL'), 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_role_grants'
             AND COLUMN_NAME = 'item_id' AND COLLATION_NAME <> @coll);
SET @s = IF(@c = 1, CONCAT('ALTER TABLE item_role_grants MODIFY COLUMN item_id VARCHAR(64) ',
                           'CHARACTER SET ', @cs, ' COLLATE ', @coll, ' NOT NULL'), 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

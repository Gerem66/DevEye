-- `sync_snapshots` et `sync_snapshot_files` épinglent `utf8mb4_general_ci`
-- (081), quand `sync_files` et `sync_versions` héritent du défaut de la base
-- (031). Sur un serveur dont le défaut diffère (`utf8mb4_0900_ai_ci` sous
-- MySQL 8), l'UNION des trois référents d'un blob lève « Illegal mix of
-- collations » : le contrôle d'intégrité du store ne tourne plus, et une
-- corruption au repos ne se découvrirait qu'à la restauration.
--
-- Les deux tables de snapshot prennent la collation effective de
-- `sync_files.hash`, et pas l'inverse : les tables de 031 portent des clés
-- étrangères vers `devices(id)`, qui hérite du même défaut, et les convertir
-- casserait ces contraintes. Rien ne référence les tables de snapshot.
--
-- Rejouable, et sans effet là où les collations coïncident déjà.

SET @cs = (SELECT CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND COLUMN_NAME = 'hash');
SET @coll = (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND COLUMN_NAME = 'hash');

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_snapshot_files'
             AND COLUMN_NAME = 'hash' AND COLLATION_NAME <> @coll);
SET @s = IF(@c = 1, CONCAT('ALTER TABLE sync_snapshot_files CONVERT TO CHARACTER SET ', @cs,
                           ' COLLATE ', @coll), 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_snapshots'
             AND COLUMN_NAME = 'kind' AND COLLATION_NAME <> @coll);
SET @s = IF(@c = 1, CONCAT('ALTER TABLE sync_snapshots CONVERT TO CHARACTER SET ', @cs,
                           ' COLLATE ', @coll), 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

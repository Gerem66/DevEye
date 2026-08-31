-- L'identifiant d'un élément partagé devient un texte : une feature choisit la
-- clé de sa table, et celle des appareils est un UUID. Les deux colonnes sont
-- des clés primaires, jamais jointes à la table de l'élément (le nettoyage est
-- applicatif) : élargir n'a d'effet sur aucune autre.

ALTER TABLE item_shares MODIFY COLUMN item_id VARCHAR(64) NOT NULL;
ALTER TABLE item_role_grants MODIFY COLUMN item_id VARCHAR(64) NOT NULL;

-- Le rang d'un élément projeté est propre à l'espace qui le reçoit : la même
-- ligne se range indépendamment dans chaque liste qui l'affiche. Chez lui, le
-- rang reste porté par la table de la feature.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_shares' AND COLUMN_NAME = 'sort_order');
SET @s = IF(@c = 0, 'ALTER TABLE item_shares ADD COLUMN sort_order INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

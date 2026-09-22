-- Le nombre de sous-taches obligatoires encore ouvertes d'une carte, en clair.
-- `projects.cardMove` ne dechiffre rien, par contrat : sans ce compteur il ne
-- saurait pas refuser l'entree dans une colonne qui vaut termine.
-- Ecrit par `cardAdd` et `cardUpdate`, les seuls a voir le clair.
--
-- Aucun rattrapage : la valeur se deduit du corps chiffre, qu'une migration ne
-- sait pas lire, et aucune carte d'avant ne porte de sous-tache obligatoire.
--
-- Rejouable : l'ajout est garde par la lecture d'INFORMATION_SCHEMA.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'project_cards'
              AND COLUMN_NAME = 'required_open_count');

SET @s = IF(@has = 0,
    'ALTER TABLE project_cards ADD COLUMN required_open_count INT NOT NULL DEFAULT 0 AFTER estimate_minutes',
    'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

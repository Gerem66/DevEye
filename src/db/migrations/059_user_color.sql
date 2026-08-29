-- Couleur d'identite du compte, pour la presence en direct (curseur, bulle,
-- bordure du noeud). Sur le compte et non sur l'adhesion : identite visuelle,
-- la meme partout (`user.setColor` est en `scope: 'account'`).
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).
SET @color_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'color'
);
SET @add_color = IF(
    @color_exists = 0,
    'ALTER TABLE users ADD COLUMN color VARCHAR(16) NOT NULL DEFAULT '''' AFTER avatar',
    'SELECT 1'
);
PREPARE stmt FROM @add_color;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Teinte deterministe depuis l'identifiant, dans l'ordre de `userColorSchema`
-- (@deveye/types). Garde sur `color = ''` : un compte ayant deja choisi n'est
-- jamais reecrase, et rejouer ce fichier ne fait rien.
UPDATE users
SET color = ELT(1 + (id MOD 8), 'red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink')
WHERE color = '';

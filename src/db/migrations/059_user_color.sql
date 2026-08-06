-- Couleur d'identite du compte, pour la presence en direct : le curseur montre
-- aux autres, la bulle dans la barre du haut, et la bordure du noeud ou le
-- compte se trouve dans l'arborescence.
--
-- Elle vit sur le compte et non sur l'adhesion a un espace : c'est une identite
-- visuelle, la meme partout, et la commande qui la change (`user.setColor`) est
-- donc en `scope: 'account'`.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, JAMAIS via
-- `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la production au
-- demarrage (voir 038_uptime_order.sql). Le motif ci-dessous ne depend d'aucun
-- sucre syntaxique recent.
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

-- Teinte deterministe depuis l'identifiant : personne n'est sans couleur des la
-- migration, et deux comptes crees a la suite ne recoivent pas la meme. L'ordre
-- des huit noms doit rester celui de `userColorSchema` dans deveye-types.
--
-- Garde sur `color = ''` : un compte ayant deja choisi sa couleur n'est jamais
-- reecrase, et rejouer ce fichier ne fait rien.
UPDATE users
SET color = ELT(1 + (id MOD 8), 'red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink')
WHERE color = '';

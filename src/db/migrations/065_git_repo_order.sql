-- Ordre des dépôts git entièrement défini par l'utilisateur (glisser-déposer),
-- comme pour les services surveillés et les notes.
--
-- Remplace le tri par date d'ajout (`ORDER BY created DESC`), qui n'était pas un
-- ordre mais une conséquence : le dépôt ajouté en dernier passait devant ceux
-- qu'on regarde tous les jours, et rien ne permettait d'y remédier. Rien ne
-- touche `sort_order` en dehors de `git.repoReorder` et de l'ajout d'un dépôt,
-- qui prend le rang suivant — donc la fin de la liste.
--
-- La colonne est ajoutée conditionnellement via INFORMATION_SCHEMA + SQL
-- dynamique, PAS via `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la
-- production au démarrage (voir 038_uptime_order.sql). Le motif ci-dessous ne
-- dépend d'aucun sucre syntaxique récent.
SET @git_sort_order_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_repos' AND COLUMN_NAME = 'sort_order'
);
SET @add_git_sort_order = IF(
    @git_sort_order_exists = 0,
    'ALTER TABLE git_repos ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER enabled',
    'SELECT 1'
);
PREPARE stmt FROM @add_git_sort_order;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Rang initial = l'ordre d'ajout, du plus ancien au plus récent, numéroté par
-- espace. L'ancienne liste montrait l'inverse (le plus récent en tête) ; c'est
-- assumé, parce qu'un ordre manuel se lit de haut en bas et que les nouveaux
-- dépôts arriveront désormais à la fin. Restreint aux rangs encore à zéro : une
-- base où le glisser-déposer aurait déjà servi n'est pas réécrasée.
UPDATE git_repos r
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY id ASC) - 1 AS rn
    FROM git_repos
) ranked ON ranked.id = r.id
SET r.sort_order = ranked.rn
WHERE r.sort_order = 0;

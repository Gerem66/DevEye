-- Ordre des dépôts git entièrement défini par l'utilisateur (glisser-déposer).
-- Rien ne touche `sort_order` en dehors de `git.repoReorder` et de l'ajout d'un
-- dépôt, qui prend le rang suivant.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).
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

-- Rang initial = l'ordre d'ajout, numéroté par espace (un ordre manuel se lit de
-- haut en bas, les nouveaux dépôts arrivent à la fin). Restreint aux rangs
-- encore à zéro : une disposition déjà posée à la main n'est pas réécrasée.
UPDATE git_repos r
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY id ASC) - 1 AS rn
    FROM git_repos
) ranked ON ranked.id = r.id
SET r.sort_order = ranked.rn
WHERE r.sort_order = 0;

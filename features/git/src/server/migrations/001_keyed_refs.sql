-- Les condenses du module passent sous cle (keys.ref) : 32 caracteres au lieu
-- de 16. L'etape de donnees 001-keyed-refs recalcule ensuite chaque ligne.
--
-- Rejouable : une colonne garde le type qu'on lui redonne, et le retrait est
-- garde par la lecture d'INFORMATION_SCHEMA.
ALTER TABLE git_repos MODIFY slug_ref CHAR(32) NOT NULL;
ALTER TABLE git_commit_authors MODIFY author_ref CHAR(32) NOT NULL;
ALTER TABLE git_commits MODIFY author_ref CHAR(32) NOT NULL;
ALTER TABLE git_branches MODIFY name_ref CHAR(32) NOT NULL;
ALTER TABLE git_releases MODIFY tag_ref CHAR(32) NOT NULL;

-- Le condense de l'auteur d'une pull request etait ecrit sans jamais etre lu.
SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'git_pull_requests'
              AND COLUMN_NAME = 'author_ref');
SET @s = IF(@has = 1, 'ALTER TABLE git_pull_requests DROP COLUMN author_ref', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

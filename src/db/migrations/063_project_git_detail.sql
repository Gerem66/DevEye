-- Projets / git : avance-retard des branches, et pull requests.
--
-- Deux manques constatés à l'usage de l'onglet Git : une liste de branches ne
-- dit pas laquelle est en retard sur la principale, et les pull requests — là
-- où se discute le travail — n'y figuraient pas du tout.
--
-- Découpage clair / chiffré inchangé (voir 061) : restent en clair les
-- compteurs, les états et les horodatages — ce sur quoi on trie et on filtre ;
-- passent par `content` le titre, la description, le nom d'auteur et les noms
-- de branches, qui identifient.
--
-- Ajouts de colonnes via INFORMATION_SCHEMA + SQL dynamique, JAMAIS via
-- `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la production au
-- démarrage (voir 038_uptime_order.sql).

-- Avance et retard d'une branche sur la branche par défaut, tels que le
-- fournisseur les calcule. NULL = jamais comparée (branche par défaut
-- elle-même, ou comparaison pas encore faite) — et non « zéro », qui voudrait
-- dire « à jour » et serait un mensonge.
SET @ahead_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_branches' AND COLUMN_NAME = 'ahead_count');
SET @add_ahead = IF(@ahead_exists = 0,
    'ALTER TABLE project_branches ADD COLUMN ahead_count INT NULL AFTER head_sha',
    'SELECT 1');
PREPARE stmt FROM @add_ahead; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @behind_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_branches' AND COLUMN_NAME = 'behind_count');
SET @add_behind = IF(@behind_exists = 0,
    'ALTER TABLE project_branches ADD COLUMN behind_count INT NULL AFTER ahead_count',
    'SELECT 1');
PREPARE stmt FROM @add_behind; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Le couple « base..tête » sur lequel l'avance-retard a été calculée. Sans lui
-- on ne saurait pas si les compteurs sont encore valides : ils cessent de
-- l'être dès qu'un des deux côtés bouge, et recomparer toutes les branches à
-- chaque tour coûterait un appel par branche pour un résultat le plus souvent
-- identique.
SET @cmp_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_branches' AND COLUMN_NAME = 'compared_sha');
SET @add_cmp = IF(@cmp_exists = 0,
    'ALTER TABLE project_branches ADD COLUMN compared_sha VARCHAR(96) NULL AFTER behind_count',
    'SELECT 1');
PREPARE stmt FROM @add_cmp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les pull requests du dépôt lié.
--
-- `number` porte l'unicité : c'est l'identité publique et stable d'une PR chez
-- le fournisseur, et elle est déjà un entier — pas besoin d'un condensé `*_ref`
-- comme pour les branches et les tags, dont le nom seul identifie.
CREATE TABLE IF NOT EXISTS project_pull_requests (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    project_id   INT         NOT NULL,
    workspace_id INT         NOT NULL,
    number       INT         NOT NULL,
    -- 'open' | 'draft' | 'merged' | 'closed'. « fusionnée » et « fermée » sont
    -- deux issues distinctes : GitHub les confond dans `state`, pas nous.
    state        VARCHAR(16) NOT NULL DEFAULT 'open',
    -- Condensé du login de l'auteur : même rôle que `author_ref` sur les
    -- commits — une identité stable sans identifiant en clair.
    author_ref   CHAR(16)    NULL,
    created_at   BIGINT      NOT NULL,
    updated_at   BIGINT      NOT NULL,
    merged_at    BIGINT      NULL,
    closed_at    BIGINT      NULL,
    -- { title, body, authorName, headBranch, baseBranch, url } chiffré.
    content      TEXT        NOT NULL,
    UNIQUE KEY uniq_project_pull (project_id, number),
    -- La liste s'ouvre sur « les plus récemment actives » : cet index la donne.
    KEY idx_project_pulls_time (project_id, updated_at),
    CONSTRAINT fk_pull_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pull_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

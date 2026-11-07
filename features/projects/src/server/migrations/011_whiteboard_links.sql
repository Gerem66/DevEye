-- La liaison projet vers tableau blanc, non exclusive dans les deux sens,
-- comme les liaisons vers les sites, les bases et les dossiers.
--
-- Sans cle etrangere vers le tableau : le module Tableau blanc peut etre
-- desinstalle, sa table avec. Un tableau supprime ou parti ailleurs retire ses
-- liaisons par le contrat d'usage de Projets (detach).
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_projects_whiteboard_links (
    project_id   INT    NOT NULL,
    board_id     INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, board_id),
    KEY idx_ft_projects_whiteboard_links_board (board_id),
    CONSTRAINT fk_ft_projects_whiteboard_links_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_projects_whiteboard_links_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

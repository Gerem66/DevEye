-- La liaison projet vers app des Stores, non exclusive dans les deux sens,
-- comme les liaisons vers les sites, les bases et les tableaux blancs.
--
-- Sans cle etrangere vers l'app : le module Stores peut etre desinstalle, sa
-- table avec. Une app supprimee ou partie ailleurs retire ses liaisons par le
-- contrat d'usage de Projets (detach).
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_projects_appstores_links (
    project_id   INT    NOT NULL,
    app_id       INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, app_id),
    KEY idx_ft_projects_appstores_links_app (app_id),
    CONSTRAINT fk_ft_projects_appstores_links_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_projects_appstores_links_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

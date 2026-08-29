-- Les liaisons d'un projet se font par fonctionnalité : `project_links` (un
-- `kind` derrière un panneau « Liens DevEye ») laisse place à une table par
-- fonctionnalité, comme `project_repo_links` (064). Les liens vers un appareil
-- ou une note disparaissent. Table rase : rien n'est déployé.
DROP TABLE IF EXISTS project_links;

-- Un projet, plusieurs services surveillés, et un même service peut servir
-- plusieurs projets : la clé primaire composite porte les deux sens.
CREATE TABLE IF NOT EXISTS project_uptime_links (
    project_id   INT    NOT NULL,
    service_id   INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, service_id),
    -- « Quels projets surveillent ce service » se lit sur cet index seul.
    KEY idx_project_uptime_links_service (service_id),
    CONSTRAINT fk_pul_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pul_service FOREIGN KEY (service_id) REFERENCES uptime_services(id) ON DELETE CASCADE,
    CONSTRAINT fk_pul_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

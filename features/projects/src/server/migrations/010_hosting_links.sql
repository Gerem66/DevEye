-- La liaison projet vers dossier d'Hebergement, non exclusive dans les deux
-- sens, comme les liaisons vers les sites, les bases et les cibles.
--
-- Sans cle etrangere vers le dossier : Hebergement est un module prive, sa
-- table peut ne pas exister. Un dossier supprime ou parti ailleurs retire ses
-- liaisons par le contrat d'usage de Projets (detach).
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_projects_hosting_links (
    project_id   INT    NOT NULL,
    pack_id      INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, pack_id),
    KEY idx_ft_projects_hosting_links_pack (pack_id),
    CONSTRAINT fk_ft_projects_hosting_links_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_projects_hosting_links_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

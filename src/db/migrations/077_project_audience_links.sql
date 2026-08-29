-- La liaison projet → site suivi, non exclusive dans les deux sens (même forme
-- que 067, 068, 069). Les trois FK sont en CASCADE : c'est la liaison qui
-- tombe, jamais ce qu'elle relie.
-- Fichier séparé de 076 : les migrations tournent hors transaction, un fichier
-- court et mono-objet ne peut pas s'arrêter à moitié.
CREATE TABLE IF NOT EXISTS project_audience_links (
    project_id   INT    NOT NULL,
    site_id      INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, site_id),
    -- « Combien de projets suivent ce site » se lit sur cet index seul.
    KEY idx_project_audience_links_site (site_id),
    CONSTRAINT fk_pal_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pal_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE,
    CONSTRAINT fk_pal_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

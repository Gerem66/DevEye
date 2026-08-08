-- Les liaisons d'un projet se font par fonctionnalité, plus par un fourre-tout.
--
-- `project_links` portait un `kind` — 'uptime' | 'device' | 'note' — derrière un
-- seul panneau « Liens DevEye » présent sur tous les onglets. Ce n'était pas une
-- intégration mais une liste de raccourcis : rien ne s'y ouvrait vraiment, rien
-- n'y était contextuel, et le panneau suivait l'utilisateur là où il n'avait
-- rien à faire.
--
-- La bonne forme est celle du dépôt git (`project_repo_links`, migration 064) :
-- une table par fonctionnalité, une place dans l'onglet qui en parle. Les
-- services surveillés rejoignent donc l'onglet « Déploiement » — c'est là qu'on
-- se demande si ce qui vient d'être livré tient debout. Les liens vers un
-- appareil ou une note disparaissent : ils n'avaient pas d'endroit où être
-- utiles.
--
-- Table rase, conformément à la règle « aucune rétro-compatibilité » du dépôt :
-- rien n'est déployé, et les quelques liens de développement se reposent en
-- deux clics.
DROP TABLE IF EXISTS project_links;

-- Un projet, plusieurs services surveillés — et un même service peut servir
-- plusieurs projets. La clé primaire composite porte les deux sens.
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

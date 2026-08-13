-- La liaison projet → site suivi.
--
-- Quatrième de la même famille, et la forme est désormais établie : dépôts
-- (069), services surveillés (067), bases de données (068), et maintenant les
-- sites. Non exclusive dans les deux sens — un projet peut suivre plusieurs
-- sites, un site peut servir plusieurs projets (un même produit, un dépôt
-- vitrine et son application, ou simplement deux projets qui partagent un
-- domaine).
--
-- Les trois clés étrangères sont en CASCADE : c'est la **liaison** qui tombe,
-- jamais ce qu'elle relie. Supprimer un projet laisse le site et son historique
-- intacts ; supprimer un site laisse les projets, qui perdent leur pointeur.
--
-- Fichier séparé de `076` volontairement : les migrations tournent au démarrage
-- **hors transaction**, donc un fichier court et mono-objet est un fichier qui
-- ne peut pas s'arrêter à moitié.
CREATE TABLE IF NOT EXISTS project_audience_links (
    project_id   INT    NOT NULL,
    site_id      INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, site_id),
    -- « Combien de projets suivent ce site » se lit sur cet index seul, donc
    -- avant qu'on clique sur « Supprimer » — pas après.
    KEY idx_project_audience_links_site (site_id),
    CONSTRAINT fk_pal_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pal_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE,
    CONSTRAINT fk_pal_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

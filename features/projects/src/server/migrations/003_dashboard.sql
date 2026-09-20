-- La vue d'ensemble d'un projet : l'agencement de ses tuiles, et les indicateurs
-- sur mesure qu'il mesure contre une base reliee.
--
-- Hors du corps chiffre du projet : reordonner et masquer ne doivent rien
-- dechiffrer, la meme raison qui garde `sort_order` en clair sur les projets et
-- les cartes. Un projet confidentiel verrouille doit pouvoir arranger ses tuiles
-- de taches, les seules a ne dependre d'aucun service exterieur.
--
-- Rien n'est seme a la creation d'un projet : le catalogue des tuiles
-- automatiques est du code, et cette table ne porte que ce qui a ete arrange.
--
-- Premiere table propre au module : le prefixe `ft_projects_` est obligatoire,
-- l'allowlist de deveye-feature.json ne dispensant que les tables du socle.
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_projects_dashboard_tiles (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    project_id    INT          NOT NULL,
    -- Le domicile du projet, jamais l'espace actif : c'est lui que le
    -- deplacement d'espace reecrit, comme partout dans l'arbre.
    workspace_id  INT          NOT NULL,
    -- La cle stable de la tuile, en clair : c'est elle que l'ordre nomme et que
    -- le client associe a un composant.
    tile_key      VARCHAR(64)  NOT NULL,
    sort_order    INT          NOT NULL DEFAULT 0,
    -- Masquee : la tuile garde son rang et ne se dessine pas. La retirer
    -- perdrait son rang et, pour un indicateur, sa requete.
    hidden        TINYINT      NOT NULL DEFAULT 0,
    -- La base que mesure un indicateur. Aucune cle etrangere : elle appartient a
    -- une autre feature et Projets n'en tient qu'un pointeur, comme
    -- project_database_links. NULL sur une tuile automatique.
    database_id   INT          NULL,
    -- { title, sql, unit, comparator, threshold } chiffre sous l'etage du projet.
    -- Vide sur une tuile automatique, qui ne porte rien qui identifie.
    content       TEXT         NOT NULL,
    -- Ce qu'a rendu la derniere mesure. Un echec renseigne `last_error` en
    -- laissant `last_number` : la tuile montre le dernier nombre connu grise
    -- sous le message, plutot que rien.
    last_number   DOUBLE       NULL,
    last_error    VARCHAR(512) NULL,
    last_check_at BIGINT       NULL,
    created       BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_projects_dashboard_tile (project_id, tile_key),
    KEY idx_ft_projects_dashboard_order (project_id, sort_order, id),
    KEY idx_ft_projects_dashboard_database (database_id, workspace_id),
    CONSTRAINT fk_ft_projects_dashboard_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

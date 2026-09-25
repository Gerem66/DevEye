-- La page publique d'un projet : son tableau, lisible sans compte, sous
-- l'adresse de DevEye ou sous un domaine verifie de son espace.
--
-- Une ligne par projet publie au moins une fois. La desactiver garde son lien,
-- que la reactivation rend tel quel. L'espace se lit sur `projects` : la ligne
-- est supprimee quand le projet change d'espace, jamais reecrite.
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_projects_public (
    project_id     INT         NOT NULL,
    -- Le lien sous l'adresse de DevEye, tire au hasard.
    public_ref     CHAR(16)    NOT NULL,
    enabled        TINYINT(1)  NOT NULL DEFAULT 0,
    -- La derniere mise en ligne : l'ordre du stock de l'offre, les plus
    -- anciennes restent servies quand la limite baisse.
    published_at   BIGINT      NULL,
    -- Le domaine qui le sert, NULL pour l'adresse de DevEye seule. Sans cle
    -- etrangere : le retrait d'un domaine passe par le module (onRemoved).
    domain_id      INT         NULL,
    -- Son chemin sous ce domaine, pose avec lui.
    slug           VARCHAR(48) NULL,
    -- Quand il a rejoint ce domaine : le plus ancien des projets actifs en
    -- tient la racine, les autres repondent sous leur chemin.
    domain_at      BIGINT      NULL,
    show_dates     TINYINT(1)  NOT NULL DEFAULT 0,
    show_assignees TINYINT(1)  NOT NULL DEFAULT 0,
    created        BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id),
    UNIQUE KEY uniq_ft_projects_public_ref (public_ref),
    UNIQUE KEY uniq_ft_projects_public_slug (domain_id, slug),
    CONSTRAINT fk_ft_projects_public_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

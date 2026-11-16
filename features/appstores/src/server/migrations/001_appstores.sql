-- Les comptes de store de l'espace. `content`, chiffre a l'etage ouvert, porte
-- ce qui identifie la cle sans etre secret (Issuer ID, Key ID, numero de
-- fournisseur, adresse du compte de service, bucket). `secret_enc` porte la cle
-- privee, jamais rendue au client. `capabilities` : ce que la cle a su lire au
-- dernier test, valeurs separees par des virgules.
CREATE TABLE IF NOT EXISTS ft_appstores_sources (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id     INT           NOT NULL,
    store            ENUM('apple','google') NOT NULL,
    content          TEXT          NOT NULL,
    secret_enc       TEXT          NOT NULL,
    capabilities     VARCHAR(100)  NOT NULL DEFAULT '',
    checked_at       BIGINT        NULL,
    -- Le premier refus d'une serie et la phrase que l'ecran en montre, ecrite
    -- par le module et jamais recopiee du store. L'avis part au troisieme refus.
    failing_since    BIGINT        NULL,
    failing_error    VARCHAR(300)  NULL,
    failing_count    INT           NOT NULL DEFAULT 0,
    failing_notified TINYINT       NOT NULL DEFAULT 0,
    created          BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_ft_appstores_sources_ws (workspace_id),
    CONSTRAINT fk_ft_appstores_sources_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les apps suivies. Le nom et le pays de reference de la note Apple sont dans
-- `content`, chiffre a l'etage ouvert : le service les lit sans session.
CREATE TABLE IF NOT EXISTS ft_appstores_apps (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id     INT           NOT NULL,
    content          TEXT          NOT NULL,
    sort_order       INT           NOT NULL DEFAULT 0,
    created          BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_ft_appstores_apps_ws (workspace_id, sort_order),
    CONSTRAINT fk_ft_appstores_apps_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- La presence d'une app sur un store, une au plus par store. `external_ref` est
-- un condense de `store:identifiant`, ce qui laisse la base refuser une meme app
-- suivie deux fois dans un espace sans rien dechiffrer. `content` porte
-- l'identifiant au store, `state` ce que le service seul ecrit (versions, note,
-- curseurs). Les jours se comptent depuis 1970, en UTC. Pas de cle etrangere
-- vers la source : InnoDB peut revalider la ligne mise a NULL contre l'espace
-- que la meme cascade supprime. Le module la remet a NULL avant de la retirer.
CREATE TABLE IF NOT EXISTS ft_appstores_listings (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    app_id            INT           NOT NULL,
    workspace_id      INT           NOT NULL,
    store             ENUM('apple','google') NOT NULL,
    source_id         INT           NULL,
    external_ref      CHAR(32)      NOT NULL,
    content           TEXT          NOT NULL,
    state             MEDIUMTEXT    NULL,
    history_from      INT           NULL,
    synced_day        INT           NULL,
    metrics_synced_at BIGINT        NULL,
    reviews_synced_at BIGINT        NULL,
    rating_synced_at  BIGINT        NULL,
    last_sync_at      BIGINT        NULL,
    sync_error        VARCHAR(300)  NULL,
    created           BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_appstores_listing_store (app_id, store),
    UNIQUE KEY uniq_ft_appstores_listing_ref (workspace_id, external_ref),
    KEY idx_ft_appstores_listings_source (source_id),
    CONSTRAINT fk_ft_appstores_listings_app FOREIGN KEY (app_id) REFERENCES ft_appstores_apps(id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_appstores_listings_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les chiffres d'un jour, par app et par store, en clair parce qu'on les
-- agrege. Une colonne a NULL : ce store ne la donne pas. Jamais purgee.
CREATE TABLE IF NOT EXISTS ft_appstores_daily (
    app_id          INT           NOT NULL,
    store           ENUM('apple','google') NOT NULL,
    day             INT           NOT NULL,
    downloads       INT           NULL,
    updates         INT           NULL,
    uninstalls      INT           NULL,
    active_devices  INT           NULL,
    rating_avg      DECIMAL(4,3)  NULL,
    rating_count    INT           NULL,
    crash_rate      DECIMAL(9,6)  NULL,
    anr_rate        DECIMAL(9,6)  NULL,
    vitals_users    INT           NULL,
    PRIMARY KEY (app_id, store, day),
    CONSTRAINT fk_ft_appstores_daily_app FOREIGN KEY (app_id) REFERENCES ft_appstores_apps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les revenus d'un jour, par devise. Apple : produits nets. Google : ventes
-- estimees, avant sa commission. Trois decimales pour les devises qui en ont.
CREATE TABLE IF NOT EXISTS ft_appstores_revenue (
    app_id          INT           NOT NULL,
    store           ENUM('apple','google') NOT NULL,
    day             INT           NOT NULL,
    currency        CHAR(3)       NOT NULL,
    amount          DECIMAL(16,3) NOT NULL DEFAULT 0,
    units           INT           NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, store, day, currency),
    CONSTRAINT fk_ft_appstores_revenue_app FOREIGN KEY (app_id) REFERENCES ft_appstores_apps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les avis. La note et les dates restent en clair pour filtrer et compter. Le
-- reste (auteur, texte, pays, version, identifiant au store, reponse) est dans
-- `content`. `external_ref` est un condense de l'identifiant de l'avis au store.
CREATE TABLE IF NOT EXISTS ft_appstores_reviews (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    app_id          INT           NOT NULL,
    store           ENUM('apple','google') NOT NULL,
    external_ref    CHAR(32)      NOT NULL,
    rating          TINYINT       NOT NULL,
    created_at      BIGINT        NOT NULL,
    replied_at      BIGINT        NULL,
    content         MEDIUMTEXT    NOT NULL,
    UNIQUE KEY uniq_ft_appstores_review (app_id, store, external_ref),
    KEY idx_ft_appstores_reviews_list (app_id, created_at),
    CONSTRAINT fk_ft_appstores_reviews_app FOREIGN KEY (app_id) REFERENCES ft_appstores_apps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

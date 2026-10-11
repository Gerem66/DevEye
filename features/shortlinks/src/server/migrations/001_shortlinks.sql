-- Les liens. `code` : l'adresse sur DevEye, valable a vie. `domain_id` et
-- `slug` : l'adresse sur un domaine de l'espace, sans cle etrangere vers le
-- socle (un domaine retire passe par le crochet du module). Le contenu (titre,
-- destinations, parametres de campagne) est chiffre a l'etage ouvert : une
-- redirection le lit sans session.
CREATE TABLE IF NOT EXISTS ft_shortlinks_links (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT           NOT NULL,
    user_id         INT           NULL,
    code            CHAR(6)       NOT NULL,
    domain_id       INT           NULL,
    slug            VARCHAR(64)   NULL,
    content         TEXT          NOT NULL,
    password_hash   VARCHAR(255)  NULL,
    expires_at      BIGINT        NULL,
    max_visits      INT           NULL,
    visits_total    BIGINT        NOT NULL DEFAULT 0,
    clicks_total    BIGINT        NOT NULL DEFAULT 0,
    enabled         TINYINT       NOT NULL DEFAULT 1,
    blocked_at      BIGINT        NULL,
    blocked_reason  VARCHAR(1000) NULL,
    check_enabled   TINYINT       NOT NULL DEFAULT 1,
    -- 'unknown', 'ok' ou 'broken'. L'erreur est une categorie (code 404, delai
    -- depasse), jamais un message qui nommerait la destination.
    check_state     VARCHAR(8)    NOT NULL DEFAULT 'unknown',
    check_error     VARCHAR(64)   NULL,
    checked_at      BIGINT        NULL,
    -- La prochaine verification : le lendemain, ou dans l'heure apres un
    -- premier echec, qu'un second confirme avant de prevenir.
    check_due       BIGINT        NULL,
    created         BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated         BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_shortlinks_code (code),
    UNIQUE KEY uniq_ft_shortlinks_slug (domain_id, slug),
    KEY idx_ft_shortlinks_ws (workspace_id, created),
    KEY idx_ft_shortlinks_check (check_enabled, check_due),
    CONSTRAINT fk_ft_shortlinks_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les chiffres d'un lien par jour UTC (`day` : jours depuis 1970). Une visite
-- est une personne, une ouverture chaque passage, et les robots se comptent a
-- part sans entrer dans les deux autres.
CREATE TABLE IF NOT EXISTS ft_shortlinks_daily (
    link_id         INT           NOT NULL,
    day             INT           NOT NULL,
    clicks          INT           NOT NULL DEFAULT 0,
    visits          INT           NOT NULL DEFAULT 0,
    bots            INT           NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, day),
    CONSTRAINT fk_ft_shortlinks_daily_link FOREIGN KEY (link_id) REFERENCES ft_shortlinks_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- D'ou viennent les visites, par jour et par dimension. Pays, appareil,
-- navigateur, systeme et langue sont des codes en clair d'un vocabulaire ferme.
-- Pour le referent, `value` est l'identifiant de son etiquette chiffree.
-- Vide : inconnu.
CREATE TABLE IF NOT EXISTS ft_shortlinks_dims (
    link_id         INT           NOT NULL,
    day             INT           NOT NULL,
    kind            VARCHAR(10)   NOT NULL,
    value           VARCHAR(64)   NOT NULL,
    visits          INT           NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, day, kind, value),
    KEY idx_ft_shortlinks_dims_day (day),
    CONSTRAINT fk_ft_shortlinks_dims_link FOREIGN KEY (link_id) REFERENCES ft_shortlinks_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les sites referents d'un espace, chiffres une fois : les classements groupent
-- sur l'identifiant. `label_ref` est un condense a cle, pas un sha256 nu qu'un
-- dictionnaire des sites connus suffirait a renverser.
CREATE TABLE IF NOT EXISTS ft_shortlinks_labels (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT           NOT NULL,
    kind            VARCHAR(10)   NOT NULL,
    label_ref       CHAR(32)      NOT NULL,
    content         TEXT          NOT NULL,
    UNIQUE KEY uniq_ft_shortlinks_label (workspace_id, kind, label_ref),
    CONSTRAINT fk_ft_shortlinks_labels_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les personnes deja comptees aujourd'hui sur un lien, par leur empreinte du
-- jour (le sel change chaque nuit). Ce qui fait foi pour dire « nouvelle
-- visite ». Les jours passes s'effacent.
CREATE TABLE IF NOT EXISTS ft_shortlinks_seen (
    day             INT           NOT NULL,
    link_id         INT           NOT NULL,
    visitor_ref     CHAR(16)      NOT NULL,
    PRIMARY KEY (day, link_id, visitor_ref),
    KEY idx_ft_shortlinks_seen_link (link_id),
    CONSTRAINT fk_ft_shortlinks_seen_link FOREIGN KEY (link_id) REFERENCES ft_shortlinks_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les visites par espace et par mois AAAA-MM : ce que l'offre borne. Sur
-- l'espace et non sur le lien, pour qu'un lien supprime puis recree ne rende
-- pas le mois. `notified` : le dernier seuil d'avis franchi ce mois (0, 80, 100).
CREATE TABLE IF NOT EXISTS ft_shortlinks_usage (
    workspace_id    INT           NOT NULL,
    month           CHAR(7)       NOT NULL,
    visits          INT           NOT NULL DEFAULT 0,
    notified        TINYINT       NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, month),
    CONSTRAINT fk_ft_shortlinks_usage_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Ce qu'un visiteur signale d'un lien, et ce que l'administration en a decide.
-- Le signalement survit au lien et a son espace : c'est la trace de la
-- decision. `workspace_id` n'a donc pas de cle etrangere. Le contenu (adresse,
-- destination, message, identite et adresse IP du signalant) est scelle par la
-- cle du serveur, lisible sans aucun espace.
CREATE TABLE IF NOT EXISTS ft_shortlinks_reports (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    ref             CHAR(12)      NOT NULL,
    link_id         INT           NULL,
    workspace_id    INT           NULL,
    reason          VARCHAR(16)   NOT NULL,
    content         TEXT          NOT NULL,
    -- 'open', 'dismissed' ou 'actioned'.
    status          VARCHAR(10)   NOT NULL DEFAULT 'open',
    decision        VARCHAR(1000) NOT NULL DEFAULT '',
    handled_by      INT           NULL,
    created         BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    closed_at       BIGINT        NULL,
    UNIQUE KEY uniq_ft_shortlinks_report_ref (ref),
    KEY idx_ft_shortlinks_reports_status (status, created),
    KEY idx_ft_shortlinks_reports_link (link_id),
    CONSTRAINT fk_ft_shortlinks_report_link FOREIGN KEY (link_id) REFERENCES ft_shortlinks_links(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

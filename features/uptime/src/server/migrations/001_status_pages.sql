-- Les pages de statut d'un espace : quelques-uns de ses services, montrés à
-- qui n'a pas de compte, sous l'adresse de DevEye ou à la racine d'un domaine
-- vérifié de l'espace.
CREATE TABLE IF NOT EXISTS ft_uptime_pages (
    id           INT          NOT NULL AUTO_INCREMENT,
    workspace_id INT          NOT NULL,
    -- Le lien sous l'adresse de DevEye, tiré au hasard.
    public_ref   CHAR(16)     NOT NULL,
    -- { title, description }, chiffré à l'étage ouvert : la page se rend sans session.
    content      TEXT         NOT NULL,
    -- Le domaine qui la sert à sa racine, NULL pour l'adresse de DevEye seule.
    -- Sans clé étrangère : le retrait d'un domaine passe par le module (onRemoved).
    domain_id    INT          NULL,
    theme        VARCHAR(8)   NOT NULL DEFAULT 'auto',
    show_errors  TINYINT(1)   NOT NULL DEFAULT 0,
    show_latency TINYINT(1)   NOT NULL DEFAULT 0,
    enabled      TINYINT(1)   NOT NULL DEFAULT 1,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (id),
    UNIQUE KEY uniq_ft_uptime_pages_ref (public_ref),
    UNIQUE KEY uniq_ft_uptime_pages_domain (domain_id),
    KEY idx_ft_uptime_pages_ws (workspace_id),
    CONSTRAINT fk_ft_uptime_pages_ws FOREIGN KEY (workspace_id)
        REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les services d'une page, dans l'ordre où elle les montre. Un service
-- supprimé en disparaît avec sa ligne.
CREATE TABLE IF NOT EXISTS ft_uptime_page_services (
    page_id    INT  NOT NULL,
    service_id INT  NOT NULL,
    sort_order INT  NOT NULL DEFAULT 0,
    -- Le nom public, chiffré à l'étage ouvert, NULL pour celui du service.
    label      TEXT NULL,
    PRIMARY KEY (page_id, service_id),
    KEY idx_ft_uptime_page_services_service (service_id),
    CONSTRAINT fk_ft_uptime_page_services_page FOREIGN KEY (page_id)
        REFERENCES ft_uptime_pages(id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_uptime_page_services_service FOREIGN KEY (service_id)
        REFERENCES uptime_services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

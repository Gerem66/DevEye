-- La maintenance du site (une ligne) et celle des features (une ligne par
-- feature fermee, absente quand elle est ouverte). Le serveur relit ces tables
-- toutes les 15 secondes : les modifier a la main suffit, sans redemarrage.
--   UPDATE site_maintenance SET active = 1
--   INSERT INTO feature_maintenance (feature, level) VALUES ('rdv', 'requests')
--   DELETE FROM feature_maintenance WHERE feature = 'rdv'
-- `message` NULL vaut le texte par defaut. `env_notice_dismissed` retient
-- qu'un administrateur a ferme le rappel de MAINTENANCE=1, remis a zero a
-- chaque demarrage que cette variable met en maintenance.
CREATE TABLE IF NOT EXISTS site_maintenance (
    id                   TINYINT       NOT NULL PRIMARY KEY DEFAULT 1,
    active               TINYINT(1)    NOT NULL DEFAULT 0,
    message              VARCHAR(1000) NULL,
    env_notice_dismissed TINYINT(1)    NOT NULL DEFAULT 0,
    updated              BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_by           INT           NULL,
    CONSTRAINT chk_site_maintenance_single CHECK (id = 1),
    CONSTRAINT fk_site_maintenance_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT IGNORE INTO site_maintenance (id) VALUES (1);

-- `requests` refuse les commandes et routes publiques de la feature, `full`
-- arrete en plus son service de fond.
CREATE TABLE IF NOT EXISTS feature_maintenance (
    feature    VARCHAR(64)                NOT NULL PRIMARY KEY,
    level      ENUM('requests', 'full')   NOT NULL DEFAULT 'requests',
    updated    BIGINT                     NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_by INT                        NULL,
    CONSTRAINT fk_feature_maintenance_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

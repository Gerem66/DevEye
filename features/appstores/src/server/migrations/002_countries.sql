-- Les premiers telechargements d'un jour, par pays, tires des memes rapports
-- que les chiffres du jour. Seuls les pays qui ont telecharge ont une ligne,
-- gardee un an : l'index sur `day` sert la purge.
CREATE TABLE IF NOT EXISTS ft_appstores_countries (
    app_id          INT           NOT NULL,
    store           ENUM('apple','google') NOT NULL,
    day             INT           NOT NULL,
    country         CHAR(2)       NOT NULL,
    downloads       INT           NOT NULL,
    PRIMARY KEY (app_id, store, day, country),
    INDEX idx_ft_appstores_countries_day (day),
    CONSTRAINT fk_ft_appstores_countries_app FOREIGN KEY (app_id) REFERENCES ft_appstores_apps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les recherches comptées pour la limite mensuelle de l'offre. Un compteur par
-- espace et par mois, et rien de la cible : la requête ne vit que dans
-- l'historique, chiffré par mot de passe. Le mois du déploiement part de zéro,
-- ce qui a été cherché avant la limite n'y pèse pas.
CREATE TABLE IF NOT EXISTS ft_osint_usage (
    workspace_id INT NOT NULL,
    -- AAAAMM en UTC, comme `ft_audience_usage.month`.
    month        INT NOT NULL,
    lookups      INT NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, month),
    CONSTRAINT fk_ft_osint_usage_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

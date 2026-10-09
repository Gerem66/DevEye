-- Le journal des integrites : une ligne par lecture des fichiers d'un service,
-- elaguee avec ses mesures (retention_days du service). Le constat et les
-- nombres restent en clair pour la liste, `detail` porte { error, lines }
-- chiffre a l'etage ouvert : l'ecart fichier par fichier, ou la raison d'une
-- lecture ratee.
CREATE TABLE IF NOT EXISTS ft_uptime_integrity_readings (
    id         BIGINT     NOT NULL AUTO_INCREMENT,
    service_id INT        NOT NULL,
    checked_at BIGINT     NOT NULL,
    -- learned, conform, drift ou failed.
    outcome    VARCHAR(8) NOT NULL,
    file_count INT        NULL,
    slowest_ms INT        NULL,
    detail     TEXT       NULL,
    PRIMARY KEY (id),
    KEY idx_ft_uptime_integrity_readings_service (service_id, checked_at),
    CONSTRAINT fk_ft_uptime_integrity_readings_service FOREIGN KEY (service_id)
        REFERENCES uptime_services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

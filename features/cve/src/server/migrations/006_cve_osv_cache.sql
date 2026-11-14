-- Le cache commun des reponses d'OSV, pour les paquets des inventaires.
--
-- Deux espaces qui dependent du meme paquet ne le demandent qu'une fois : par
-- paquet, la liste des avis qui le touchent (cle = empreinte de l'ecosysteme,
-- du nom et de la version, rien de lisible) et, par avis, sa description, qui
-- est publique. Ni l'une ni l'autre ne porte d'espace.
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_cve_osv_queries (
    pkg_key    CHAR(64)   NOT NULL PRIMARY KEY,
    vuln_ids   TEXT       NOT NULL,
    fetched_at BIGINT     NOT NULL,
    KEY idx_ft_cve_osv_queries_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_cve_osv_vulns (
    id         VARCHAR(80) NOT NULL PRIMARY KEY,
    body       MEDIUMTEXT  NOT NULL,
    fetched_at BIGINT      NOT NULL,
    KEY idx_ft_cve_osv_vulns_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les deux catalogues que la veille consulte en plus du NVD et d'OSV, communs
-- a tout le serveur.
--
-- ft_cve_eol_products : les fins de vie d'endoflife.date, un produit par ligne
-- (ses alias, ses identifiants, ses branches, en JSON). Le catalogue entier se
-- relit une fois par jour et remplace celui-ci.
--
-- ft_cve_pkg_meta : ce que deps.dev dit d'un paquet (sa derniere version, les
-- versions que son auteur deprecie), garde un jour. La cle est l'empreinte du
-- registre et du nom, rien de lisible.
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_cve_eol_products (
    product    VARCHAR(100) NOT NULL PRIMARY KEY,
    body       MEDIUMTEXT   NOT NULL,
    fetched_at BIGINT       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_cve_pkg_meta (
    pkg_key    CHAR(64)   NOT NULL PRIMARY KEY,
    body       MEDIUMTEXT NOT NULL,
    fetched_at BIGINT     NOT NULL,
    KEY idx_ft_cve_pkg_meta_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les produits touches par chaque CVE, et les produits qu'un module surveille.
--
-- ft_cve_products range ce que le NVD dit d'une CVE dans ses configurations :
-- un editeur, un produit, puis une version exacte ou des bornes. C'est ce qui
-- permet de demander quelles CVE touchent nginx 1.25.3 sans appeler le NVD a
-- chaque fois. Pas de cle etrangere vers ft_cve_entries, comme pour les
-- epingles : la purge retire elle-meme les produits de ce qu'elle oublie.
--
-- ft_cve_watched dit quels produits gardent tout leur historique : leurs CVE
-- anciennes sont rattrapees une fois, par pages, puis la purge des 180 jours
-- les epargne. backfill_index est la page suivante a demander, backfilled_at
-- dit que le rattrapage est fini.
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_cve_products (
    cve_id     VARCHAR(32)  NOT NULL,
    vendor     VARCHAR(100) NOT NULL,
    product    VARCHAR(150) NOT NULL,
    version    VARCHAR(64)  NULL,
    start_incl VARCHAR(64)  NULL,
    start_excl VARCHAR(64)  NULL,
    end_incl   VARCHAR(64)  NULL,
    end_excl   VARCHAR(64)  NULL,
    KEY idx_ft_cve_products_product (vendor, product),
    KEY idx_ft_cve_products_cve (cve_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_cve_watched (
    vendor         VARCHAR(100) NOT NULL,
    product        VARCHAR(150) NOT NULL,
    requested_at   BIGINT       NOT NULL,
    backfill_index INT          NOT NULL DEFAULT 0,
    backfilled_at  BIGINT       NULL,
    PRIMARY KEY (vendor, product)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

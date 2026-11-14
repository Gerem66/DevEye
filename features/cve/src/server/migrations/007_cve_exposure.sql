-- L'exposition de chaque espace : ce qu'il fait tourner, et ce qui le touche.
--
-- ft_cve_assets : un element suivi (un depot Git, plus tard un appareil, une
-- base), vu par un espace. ref est son identifiant chez sa feature. revision
-- dit ce que la source annoncait a la derniere lecture (la tete du depot),
-- digest ce qui a ete lu (l'arbre) : une revision inchangee ne relit rien.
-- announced passe a 1 une fois le premier inventaire de l'element evalue : ce
-- qu'il trouve alors part en un seul recapitulatif, pas en une alerte par
-- constat.
-- summary_enc (le nom, les formats trouves) et inventory_enc (les composants)
-- sont scelles par le chiffre de l'espace : un inventaire dit ce qu'un depot
-- prive contient.
--
-- ft_cve_asset_keys : les empreintes des produits que chaque element emploie.
-- Une CVE fraichement ingeree trouve ainsi les espaces qu'elle peut
-- toucher sans rien dechiffrer.
--
-- ft_cve_findings : un constat par sujet et par espace (une faille sur un
-- paquet, une fin de vie). origin dit quel catalogue l'a etabli : quand il ne
-- repond pas, ses constats restent tels quels. Le detail, et la liste de ce qui
-- est touche, sont scelles dans content_enc.
--
-- ft_cve_finding_assets : les elements qu'un constat touche, en clair pour que
-- le decompte filtre par droits sans dechiffrer. covered marque ceux qu'une
-- decision d'ignorer a vus : un element touche apres elle rouvre le constat.
--
-- Rejouable : creation sous garde d'existence.

CREATE TABLE IF NOT EXISTS ft_cve_assets (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id  INT          NOT NULL,
    source        VARCHAR(16)  NOT NULL,
    ref           VARCHAR(64)  NOT NULL,
    status        ENUM('pending', 'ok', 'error') NOT NULL DEFAULT 'pending',
    excluded      TINYINT(1)   NOT NULL DEFAULT 0,
    revision      VARCHAR(128) NULL,
    digest        VARCHAR(128) NULL,
    checked_at    BIGINT       NULL,
    scanned_at    BIGINT       NULL,
    refresh_asked TINYINT(1)   NOT NULL DEFAULT 0,
    announced     TINYINT(1)   NOT NULL DEFAULT 0,
    error_enc     TEXT         NULL,
    summary_enc   TEXT         NULL,
    inventory_enc MEDIUMTEXT   NULL,
    created       BIGINT       NOT NULL,
    UNIQUE KEY uniq_ft_cve_assets_ref (workspace_id, source, ref),
    CONSTRAINT fk_ft_cve_assets_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_cve_asset_keys (
    asset_id INT      NOT NULL,
    key_hash CHAR(64) NOT NULL,
    PRIMARY KEY (asset_id, key_hash),
    KEY idx_ft_cve_asset_keys_hash (key_hash),
    CONSTRAINT fk_ft_cve_asset_keys_asset FOREIGN KEY (asset_id) REFERENCES ft_cve_assets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_cve_findings (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id   INT          NOT NULL,
    kind           ENUM('vuln', 'eol', 'deprecated', 'outdated') NOT NULL,
    origin         VARCHAR(16)  NOT NULL,
    subject_key    CHAR(64)     NOT NULL,
    advisory_id    VARCHAR(80)  NULL,
    severity       ENUM('none', 'low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'none',
    score          DECIMAL(3,1) NULL,
    state          ENUM('open', 'ignored', 'resolved') NOT NULL DEFAULT 'open',
    first_seen     BIGINT       NOT NULL,
    last_seen      BIGINT       NOT NULL,
    resolved_at    BIGINT       NULL,
    due_at         BIGINT       NULL,
    notified_stage VARCHAR(16)  NULL,
    content_enc    MEDIUMTEXT   NOT NULL,
    ignored_by     INT          NULL,
    ignored_at     BIGINT       NULL,
    reason_enc     TEXT         NULL,
    UNIQUE KEY uniq_ft_cve_findings_subject (workspace_id, kind, subject_key),
    KEY idx_ft_cve_findings_state (workspace_id, state, kind),
    CONSTRAINT fk_ft_cve_findings_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_cve_finding_assets (
    finding_id INT        NOT NULL,
    asset_id   INT        NOT NULL,
    covered    TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (finding_id, asset_id),
    KEY idx_ft_cve_finding_assets_asset (asset_id),
    CONSTRAINT fk_ft_cve_finding_assets_finding FOREIGN KEY (finding_id) REFERENCES ft_cve_findings(id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_cve_finding_assets_asset FOREIGN KEY (asset_id) REFERENCES ft_cve_assets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

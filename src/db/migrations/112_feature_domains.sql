-- Les domaines qu'une fonctionnalité sert pour un espace (une page publique,
-- une boîte mail), déclarés dans ses réglages et vérifiés en deux étages :
-- la propriété par un TXT que le socle relit, puis le service par la sonde du
-- module.
--
-- `host` et `token` sont en clair : tous deux sont publiés dans le DNS, et le
-- routage d'une requête entrante part du nom d'hôte, sans session ni clé.
--
-- L'unicité est par fonctionnalité : un même nom peut porter des pages pour
-- l'une et du courrier pour l'autre, mais pas deux espaces pour la même.

CREATE TABLE IF NOT EXISTS feature_domains (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id  INT          NOT NULL,
    feature       VARCHAR(32)  NOT NULL,
    host          VARCHAR(253) NOT NULL,
    token         CHAR(32)     NOT NULL,
    -- 'pending' | 'ok' | 'failed', pour les deux étages
    dns_state     VARCHAR(8)   NOT NULL DEFAULT 'pending',
    dns_error     VARCHAR(255) NOT NULL DEFAULT '',
    probe_state   VARCHAR(8)   NOT NULL DEFAULT 'pending',
    probe_error   VARCHAR(255) NOT NULL DEFAULT '',
    verified_at   BIGINT       NULL,
    checked_at    BIGINT       NULL,
    -- Échecs consécutifs : un domaine vérifié ne retombe qu'au troisième.
    failures      INT          NOT NULL DEFAULT 0,
    next_probe_at BIGINT       NULL,
    created       BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_feature_domains_host (feature, host),
    KEY idx_feature_domains_ws (workspace_id, feature),
    KEY idx_feature_domains_due (next_probe_at),
    CONSTRAINT fk_feature_domains_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Le module Rendez-vous tenait ses domaines dans sa propre table. Les ids sont
-- repris tels quels, pour que les types qui les désignent restent valides. La
-- table est neuve à cet instant, donc aucun id ne peut se heurter.
SET @has_rdv = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_rdv_domains');
SET @s = IF(@has_rdv = 1,
    "INSERT IGNORE INTO feature_domains
        (id, workspace_id, feature, host, token, dns_state, dns_error, probe_state, probe_error,
         verified_at, checked_at, failures, next_probe_at, created)
     SELECT id, workspace_id, 'x-rdv', host, token, dns_state, dns_error, probe_state, probe_error,
            verified_at, checked_at, failures, next_probe_at, created
       FROM ft_rdv_domains",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

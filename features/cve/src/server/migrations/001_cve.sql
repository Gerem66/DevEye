-- Le catalogue des vulnerabilites, et les epingles de chaque espace.
--
-- ft_cve_entries n'a PAS de workspace_id, seule table du genre : le corpus du
-- NVD est le meme pour tout le monde et son quota de requetes est partage par
-- tout le serveur, l'ingerer une fois par espace serait absurde. Tout ce qui
-- est propre a un espace, lui, le porte.
--
-- Rien n'est chiffre : une CVE est publique, et c'est ce qui permet la
-- recherche en SQL.
--
-- ft_cve_state porte le curseur d'ingestion, global lui aussi. Il ne peut pas
-- se deduire de fetched_at ni de last_modified des entrees : une lecture a la
-- demande en ecrit aussi, et ferait sauter au ticker la fenetre qu'elle a
-- enjambee.
--
-- Rejouable : creation sous garde d'existence.

SET @has_entries = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_cve_entries');

SET @s = IF(@has_entries = 0,
    "CREATE TABLE ft_cve_entries (
        cve_id VARCHAR(32) NOT NULL,
        published BIGINT NOT NULL,
        last_modified BIGINT NOT NULL,
        severity ENUM('none', 'low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'none',
        score DECIMAL(3,1) NULL,
        vector VARCHAR(128) NULL,
        cwe VARCHAR(64) NULL,
        summary TEXT NOT NULL,
        refs JSON NOT NULL,
        fetched_at BIGINT NOT NULL,
        PRIMARY KEY (cve_id),
        KEY idx_cve_published (published),
        KEY idx_cve_severity_published (severity, published)
    )",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_favorites = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_cve_favorites');

-- Pas de cle etrangere vers ft_cve_entries : l'une est globale, l'autre par
-- espace, et la purge du catalogue epargne deja ce qu'une epingle designe.
-- user_id ne dit que qui a epingle : le cloisonnement est par espace.
SET @s = IF(@has_favorites = 0,
    "CREATE TABLE ft_cve_favorites (
        workspace_id INT NOT NULL,
        cve_id VARCHAR(32) NOT NULL,
        user_id INT NOT NULL,
        created BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, cve_id),
        KEY idx_cve_fav_created (workspace_id, created),
        CONSTRAINT fk_cve_fav_workspace FOREIGN KEY (workspace_id)
            REFERENCES workspaces (id) ON DELETE CASCADE
    )",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_state = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_cve_state');

SET @s = IF(@has_state = 0,
    "CREATE TABLE ft_cve_state (
        k VARCHAR(32) NOT NULL,
        v BIGINT NOT NULL,
        PRIMARY KEY (k)
    )",
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les bases de données, entités de l'espace (même forme que les dépôts git,
-- 064) : plusieurs projets peuvent viser la même, certaines ne servent aucun
-- projet. Elles vivent à l'étage ouvert du chiffrement, le relevé périodique
-- tournant sans session : un projet confidentiel ne peut pas en lier.
-- Deux secrets vivent ici, chacun dans sa colonne et jamais dans `content` : le
-- mot de passe de la base et celui du tunnel. Aucun ne sort du serveur.

-- `database_connections`, et non `databases` : ce dernier est un mot réservé
-- de MySQL (`SHOW DATABASES`) et `CREATE TABLE databases` échoue à l'analyse.
CREATE TABLE IF NOT EXISTS database_connections (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT          NOT NULL,
    -- 'mysql' | 'postgres'
    engine          VARCHAR(16)  NOT NULL DEFAULT 'mysql',
    -- 16 premiers caractères du sha256 du nom en minuscules : le chiffrement
    -- étant non déterministe, `content` ne peut porter l'unicité (cf. `slug_ref`).
    name_ref        CHAR(16)     NOT NULL,
    -- Rang dans la liste, entièrement défini par l'utilisateur.
    sort_order      INT          NOT NULL DEFAULT 0,
    -- Le relevé périodique est éteint par défaut : rien ne joint une base tant
    -- que personne ne l'a demandé. Ce drapeau seul fait entrer une base dans la
    -- boucle de fond.
    monitor_enabled TINYINT      NOT NULL DEFAULT 0,
    interval_seconds INT         NOT NULL DEFAULT 300,
    last_check_at   BIGINT       NULL,
    -- 'unknown' | 'up' | 'down'. « unknown » est l'état normal d'une base
    -- jamais jointe, pas une panne.
    status          VARCHAR(16)  NOT NULL DEFAULT 'unknown',
    -- Message du dernier échec, chiffré ; NULL après un succès.
    last_error      TEXT         NULL,
    server_version  VARCHAR(255) NULL,
    size_bytes      BIGINT       NULL,
    table_count     INT          NULL,
    -- { name, host, port, database, username } chiffré, étage ouvert.
    content         TEXT         NOT NULL,
    -- Mot de passe de la base, chiffré. Ne sort jamais du serveur.
    secret_enc      TEXT         NULL,
    -- { kind, host, port, username, auth } chiffré.
    access_content  TEXT         NULL,
    -- Mot de passe SSH ou clé privée, chiffré. Ne sort jamais du serveur.
    access_secret_enc TEXT       NULL,
    created         BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_database_name (workspace_id, name_ref),
    -- L'ordonnanceur ne lit que les bases surveillées, les plus en retard
    -- d'abord — d'où le drapeau en tête de l'index.
    KEY idx_database_connections_due (monitor_enabled, last_check_at),
    CONSTRAINT fk_database_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Une alerte : des conditions SQL, un opérateur qui les relie, un message.
-- `firing` porte l'état courant, en clair : ne notifier qu'aux transitions
-- plutôt qu'à chaque relevé, et compter les alertes franchies sans déchiffrer.
CREATE TABLE IF NOT EXISTS database_alerts (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    database_id   INT         NOT NULL,
    workspace_id  INT         NOT NULL,
    enabled       TINYINT     NOT NULL DEFAULT 1,
    -- 'and' | 'or'
    combinator    VARCHAR(8)  NOT NULL DEFAULT 'and',
    firing        TINYINT     NOT NULL DEFAULT 0,
    last_check_at BIGINT      NULL,
    last_fired_at BIGINT      NULL,
    -- Message d'échec de la dernière évaluation, chiffré ; NULL si elle a abouti.
    last_error    TEXT        NULL,
    -- { name, conditions, message, lastValues } chiffré. Les requêtes SQL sont
    -- du contenu utilisateur : elles n'ont pas à être lisibles en base.
    content       TEXT        NOT NULL,
    created       BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_database_alerts_db (database_id),
    CONSTRAINT fk_database_alert_db FOREIGN KEY (database_id) REFERENCES database_connections(id) ON DELETE CASCADE,
    CONSTRAINT fk_database_alert_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- La liaison projet → base, non exclusive dans les deux sens. Les FK sont en
-- CASCADE : supprimer un projet ou une base ne fait tomber que la liaison.
CREATE TABLE IF NOT EXISTS project_database_links (
    project_id   INT    NOT NULL,
    database_id  INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, database_id),
    -- « Combien de projets utilisent cette base » se lit sur cet index seul.
    KEY idx_project_database_links_db (database_id),
    CONSTRAINT fk_pdl_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdl_database FOREIGN KEY (database_id) REFERENCES database_connections(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdl_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Les bases de données, entités de l'espace.
--
-- Même forme que les dépôts git (migration 064), et pour les mêmes raisons :
-- une base ne se lie pas à un projet, plusieurs projets peuvent viser la même,
-- et certaines ne servent aucun projet. Elle vit donc à l'étage **ouvert** du
-- chiffrement — un projet confidentiel ne peut pas en lier, puisque le relevé
-- périodique tourne sans session.
--
-- Deux secrets vivent ici, chacun dans sa colonne et jamais dans `content` :
-- le mot de passe de la base, et celui du tunnel (mot de passe SSH ou clé
-- privée). Aucun des deux ne sort du serveur — les DTO n'en portent qu'un
-- booléen. Les deux sont déclarés dans `workspaceRekey`, sans quoi une
-- conversion de clé d'espace les rendrait illisibles sans rien pour le signaler.

-- ⚠️ `database_connections`, et non `databases` : ce dernier est un mot réservé
-- de MySQL (`SHOW DATABASES`) et `CREATE TABLE databases` échoue à l'analyse.
-- Le contourner à coups de guillemets obliques dans chaque requête reviendrait
-- à confier la correction à la vigilance ; un nom libre la rend inutile.
CREATE TABLE IF NOT EXISTS database_connections (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT          NOT NULL,
    -- 'mysql' | 'postgres'
    engine          VARCHAR(16)  NOT NULL DEFAULT 'mysql',
    -- 16 premiers caractères du sha256 du nom en minuscules. Le chiffrement
    -- étant non déterministe, `content` ne peut porter aucune contrainte
    -- d'unicité — même motif que `slug_ref` sur les dépôts git.
    name_ref        CHAR(16)     NOT NULL,
    -- Rang dans la liste, entièrement défini par l'utilisateur.
    sort_order      INT          NOT NULL DEFAULT 0,
    -- Le relevé périodique est **éteint par défaut** : rien ne joint une base
    -- tant que personne ne l'a demandé. C'est ce drapeau, et lui seul, qui fait
    -- entrer une base dans la boucle de fond — et qui rend ses alertes vivantes.
    monitor_enabled TINYINT      NOT NULL DEFAULT 0,
    interval_seconds INT         NOT NULL DEFAULT 300,
    last_check_at   BIGINT       NULL,
    -- 'unknown' | 'up' | 'down'. « unknown » est l'état normal d'une base
    -- jamais jointe, pas une panne : les confondre ferait passer une feature au
    -- repos pour une feature en alerte.
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
--
-- `firing` porte l'état **courant**, en clair : c'est ce qui permet de ne
-- notifier qu'aux transitions (comme les incidents d'Uptime) plutôt qu'à chaque
-- relevé, et de compter les alertes franchies d'un espace sans rien déchiffrer.
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

-- La liaison projet → base, non exclusive dans les deux sens : un projet peut
-- suivre plusieurs bases, une base peut servir plusieurs projets. Les FK sont
-- en CASCADE, donc supprimer un projet **ou** une base ne fait tomber que cette
-- ligne de liaison.
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

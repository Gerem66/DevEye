-- Projets : suivi du travail, des premières phases au déploiement.
--
-- Découpage clair / chiffré (voir Docs/SECURITY_MODEL.md) : reste en clair ce
-- dont le serveur a besoin pour lister, trier, compter et router sans
-- déchiffrer, tout ce qui identifie passe par `content` chiffré.
-- L'étage est choisi par projet (`security_tier`) : `open` autorise la
-- synchronisation de fond, `guarded` n'ouvre le projet que sur session
-- déverrouillée. Tout l'arbre d'un projet suit le tier de son projet.
--
-- Rien ne se supprime (`archived_at`), et les références vers `users` sont
-- `ON DELETE SET NULL` : le départ d'une personne ne doit pas emporter les
-- projets d'un espace partagé (le client affiche « compte supprimé »).

CREATE TABLE IF NOT EXISTS projects (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id   INT         NOT NULL,
    -- Auteur, pour l'attribution seule. NULL = compte supprimé depuis.
    user_id        INT         NULL,
    status         VARCHAR(16) NOT NULL DEFAULT 'active',
    -- 'open' | 'guarded' — quel coffre chiffre tout l'arbre de ce projet.
    security_tier  VARCHAR(8)  NOT NULL DEFAULT 'open',
    -- 'manual' | 'github_release'
    version_source VARCHAR(16) NOT NULL DEFAULT 'manual',
    sort_order     INT         NOT NULL DEFAULT 0,
    start_date     BIGINT      NULL,
    due_date       BIGINT      NULL,
    archived_at    BIGINT      NULL,
    -- { title, description, tags[], version } chiffré selon `security_tier`.
    content        TEXT        NOT NULL,
    created        BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated        BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- Le portefeuille ne lit que les projets vivants d'un espace, dans l'ordre.
    KEY idx_projects_workspace (workspace_id, archived_at, sort_order),
    CONSTRAINT fk_project_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_milestones (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    project_id   INT    NOT NULL,
    workspace_id INT    NOT NULL,
    due_date     BIGINT NOT NULL,
    -- Horodatage d'atteinte ; NULL tant que le jalon est devant nous.
    reached_at   BIGINT NULL,
    sort_order   INT    NOT NULL DEFAULT 0,
    -- { name, description } chiffré.
    content      TEXT   NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_project_milestones_project (project_id, due_date),
    CONSTRAINT fk_milestone_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_milestone_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_columns (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    project_id    INT     NOT NULL,
    workspace_id  INT     NOT NULL,
    sort_order    INT     NOT NULL DEFAULT 0,
    -- Cette colonne vaut « terminé » : c'est ce qui rend l'avancement calculable
    -- en SQL, sans déchiffrer le nom de la colonne.
    counts_as_done TINYINT NOT NULL DEFAULT 0,
    -- Limite de travail en cours ; NULL = pas de limite.
    wip_limit     INT     NULL,
    -- { name, color } chiffré.
    content       TEXT    NOT NULL,
    created       BIGINT  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_project_columns_project (project_id, sort_order),
    CONSTRAINT fk_column_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_column_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_cards (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    project_id       INT     NOT NULL,
    workspace_id     INT     NOT NULL,
    column_id        INT     NOT NULL,
    sort_order       INT     NOT NULL DEFAULT 0,
    author_user_id   INT     NULL,
    -- À qui la carte est attribuée ; NULL = personne. En clair, parce que c'est
    -- ce qui rend « mes tâches, tous projets » possible en une requête.
    assignee_user_id INT     NULL,
    -- 0 = aucune, 1 = basse, 2 = normale, 3 = haute.
    priority         TINYINT NOT NULL DEFAULT 0,
    start_date       BIGINT  NULL,
    due_date         BIGINT  NULL,
    estimate_minutes INT     NULL,
    milestone_id     INT     NULL,
    -- Les blocs ne se suppriment pas, ils s'archivent.
    archived_at      BIGINT  NULL,
    -- Dénormalisé exprès : le badge « des messages ici » doit se calculer sans
    -- déchiffrer quoi que ce soit, ni parcourir les messages.
    message_count    INT     NOT NULL DEFAULT 0,
    last_message_at  BIGINT  NULL,
    -- { title, description, checklist[] } chiffré.
    content          TEXT    NOT NULL,
    created          BIGINT  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated          BIGINT  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_project_cards_column (column_id, archived_at, sort_order),
    KEY idx_project_cards_project (project_id, archived_at),
    -- « Mes tâches » : toutes mes cartes vivantes, tous projets d'un espace.
    KEY idx_project_cards_assignee (workspace_id, assignee_user_id, archived_at),
    -- La frise ne lit que les cartes datées.
    KEY idx_project_cards_dates (project_id, due_date),
    CONSTRAINT fk_card_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_card_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_card_column FOREIGN KEY (column_id) REFERENCES project_columns(id) ON DELETE CASCADE,
    CONSTRAINT fk_card_milestone FOREIGN KEY (milestone_id) REFERENCES project_milestones(id) ON DELETE SET NULL,
    CONSTRAINT fk_card_author FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_card_assignee FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Dépendances entre cartes : `card_id` est bloquée par `blocked_by_card_id`.
-- Pas de garde d'acyclicité côté SQL : c'est le handler qui refuse un cycle.
CREATE TABLE IF NOT EXISTS project_card_deps (
    card_id            INT NOT NULL,
    blocked_by_card_id INT NOT NULL,
    project_id         INT NOT NULL,
    created            BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (card_id, blocked_by_card_id),
    KEY idx_card_deps_blocker (blocked_by_card_id),
    CONSTRAINT fk_dep_card FOREIGN KEY (card_id) REFERENCES project_cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_dep_blocker FOREIGN KEY (blocked_by_card_id) REFERENCES project_cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_dep_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_messages (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    card_id        INT    NOT NULL,
    project_id     INT    NOT NULL,
    workspace_id   INT    NOT NULL,
    author_user_id INT    NULL,
    -- Tableau JSON d'identifiants de membres mentionnés. En clair : le serveur
    -- connaît déjà l'appartenance à l'espace, et c'est ce qui permet de compter
    -- « mes mentions non lues » sans déchiffrer un seul message.
    mentions       JSON   NULL,
    created        BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    edited         BIGINT NULL,
    -- { text } chiffré.
    content        TEXT   NOT NULL,
    KEY idx_project_messages_card (card_id, id),
    CONSTRAINT fk_message_card FOREIGN KEY (card_id) REFERENCES project_cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_message_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_message_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_message_author FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Jusqu'où chacun a lu, par carte. Le badge « non lus » est un COUNT sur
-- `project_messages.id > last_read_message_id` : aucune ligne déchiffrée.
--
-- `last_read_message_id` n'a **pas** de clé étrangère, volontairement : c'est un
-- point d'eau haute, qui doit rester valide même si le message correspondant
-- venait à disparaître.
CREATE TABLE IF NOT EXISTS project_card_reads (
    card_id              INT    NOT NULL,
    user_id              INT    NOT NULL,
    workspace_id         INT    NOT NULL,
    last_read_message_id BIGINT NOT NULL DEFAULT 0,
    read_at              BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (card_id, user_id),
    KEY idx_card_reads_user (user_id, workspace_id),
    CONSTRAINT fk_read_card FOREIGN KEY (card_id) REFERENCES project_cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_read_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_read_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- La frise verticale « Historique » d'un projet : tout ce qui lui est arrivé de
-- notable. `ref_type` / `ref_id` pointent la chose concernée (une carte
-- archivée, un jalon, une release) pour que la frise sache l'ouvrir en lecture
-- seule ; le libellé et le avant/après vivent dans `content`, chiffrés.
CREATE TABLE IF NOT EXISTS project_events (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    project_id     INT         NOT NULL,
    workspace_id   INT         NOT NULL,
    -- NULL = une tâche de fond (synchronisation git, déploiement automatique).
    actor_user_id  INT         NULL,
    kind           VARCHAR(32) NOT NULL,
    ref_type       VARCHAR(16) NULL,
    ref_id         BIGINT      NULL,
    created        BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- { label, from, to } chiffré.
    content        TEXT        NOT NULL,
    KEY idx_project_events_project (project_id, created),
    CONSTRAINT fk_event_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_event_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Liens croisés vers le reste de DevEye : un service Uptime, un appareil de la
-- flotte, une note. On ne stocke que le type et l'identifiant — la cible garde
-- ses propres droits, et rien d'identifiant n'a besoin d'être chiffré ici.
CREATE TABLE IF NOT EXISTS project_links (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    project_id   INT         NOT NULL,
    workspace_id INT         NOT NULL,
    -- 'uptime' | 'device' | 'note'
    kind         VARCHAR(16) NOT NULL,
    target_id    VARCHAR(64) NOT NULL,
    created      BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_project_link (project_id, kind, target_id),
    CONSTRAINT fk_link_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_link_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

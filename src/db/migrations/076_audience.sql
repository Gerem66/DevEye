-- L'audience : ce que les gens font des projets une fois livrés. Un site suivi
-- appartient à l'espace (même forme que 064 et 068) et vit à l'étage ouvert :
-- l'ingestion tourne sans session.
--
-- Une statistique est un GROUP BY : rien de ce sur quoi on agrège ne peut être
-- chiffré. D'où `audience_labels` : le libellé chiffré y est stocké une fois,
-- les tables de faits n'en portent que l'identifiant entier. Restent en clair
-- sur le site sa clé publique, ses origines, son état et sa plateforme : ce dont
-- l'ingestion a besoin sans session, et de toute façon exposés dans la page.

CREATE TABLE IF NOT EXISTS audience_sites (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id   INT          NOT NULL,
    -- `pk_` + 24 caractères. En clair et unique globalement : c'est la seule
    -- chose dont dispose une requête d'ingestion (sans session ni espace) pour
    -- retrouver son site. Publique par nature, elle est dans le HTML de la page.
    public_key     CHAR(27)     NOT NULL,
    -- 16 premiers caractères du sha256 du nom en minuscules : le chiffrement
    -- étant non déterministe, `content` ne peut porter l'unicité (cf. `slug_ref`).
    name_ref       CHAR(16)     NOT NULL,
    -- 'web' | 'app' | 'both'. Décide si l'en-tête `Origin` est confronté aux
    -- origines autorisées : un client natif n'en envoie aucun, et refuser son
    -- absence lui fermerait la porte pour de bon.
    platform       VARCHAR(8)   NOT NULL DEFAULT 'web',
    -- Hôtes autorisés, séparés par des sauts de ligne. NULL ou vide = on accepte
    -- toute origine ; l'écran le signale comme un état transitoire, le temps de
    -- brancher, et non comme un réglage à laisser en place.
    origins        TEXT         NULL,
    -- Éteint, plus rien n'entre. L'historique déjà collecté ne bouge pas.
    active         TINYINT      NOT NULL DEFAULT 1,
    -- Conservation des événements **bruts**. `audience_daily`, lui, survit.
    retention_days INT          NOT NULL DEFAULT 180,
    -- Rang dans la liste, entièrement défini par l'utilisateur.
    sort_order     INT          NOT NULL DEFAULT 0,
    -- Dernier événement reçu. NULL = jamais rien reçu, l'état normal d'un site
    -- qu'on vient de déclarer, pas une panne.
    last_event_at  BIGINT       NULL,
    -- { name, description } chiffré, étage ouvert.
    content        TEXT         NOT NULL,
    created        BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_audience_site_key (public_key),
    UNIQUE KEY uniq_audience_site_name (workspace_id, name_ref),
    KEY idx_audience_sites_order (workspace_id, sort_order),
    CONSTRAINT fk_audience_site_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- La table de dimensions : un libellé chiffré, dédoublonné par son condensé. Un
-- chemin vu mille fois y occupe une ligne, et un classement se calcule sans
-- toucher à une clé de chiffrement.
-- `kind` reprend les valeurs d'`audienceDimensionSchema` : un seul vocabulaire
-- pour le stockage et pour l'axe demandé par `audience.breakdown`.
CREATE TABLE IF NOT EXISTS audience_labels (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    site_id   INT         NOT NULL,
    kind      VARCHAR(12) NOT NULL,
    -- 16 premiers caractères du sha256 de la valeur normalisée.
    label_ref CHAR(16)    NOT NULL,
    content   TEXT        NOT NULL,
    -- La clé de la résolution « ce libellé existe-t-il déjà ? », faite à chaque
    -- événement. C'est l'index le plus sollicité de la feature.
    UNIQUE KEY uniq_audience_label (site_id, kind, label_ref),
    CONSTRAINT fk_audience_label_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
);

-- Une session : un visiteur, une fenêtre de temps, et les dimensions qui ne
-- changent pas en cours de route (portées ici plutôt que sur chaque événement).
--
-- `visitor_ref` = sha256(clé du site + IP + user-agent + sel du jour), tronqué.
-- Ni l'IP ni le user-agent ne sont stockés, et le sel tournant fait qu'un même
-- visiteur n'est pas reconnaissable d'un jour à l'autre. Pas de cookie, donc
-- rien à faire accepter par un bandeau de consentement.
CREATE TABLE IF NOT EXISTS audience_sessions (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    site_id       INT      NOT NULL,
    visitor_ref   CHAR(16) NOT NULL,
    started_at    BIGINT   NOT NULL,
    last_at       BIGINT   NOT NULL,
    views         INT      NOT NULL DEFAULT 0,
    entry_path_id INT      NULL,
    referrer_id   INT      NULL,
    browser_id    INT      NULL,
    os_id         INT      NULL,
    device_id     INT      NULL,
    timezone_id   INT      NULL,
    language_id   INT      NULL,
    identity_id   INT      NULL,
    -- Décalage local du visiteur, en minutes : c'est lui, et non l'heure
    -- serveur, qui donne son sens à la carte d'activité.
    tz_offset     SMALLINT NULL,
    screen_width  INT      NULL,
    -- Visiteurs uniques sur une fenêtre : `visitor_ref` est dans l'index, donc
    -- le COUNT(DISTINCT) se lit sans toucher aux lignes.
    KEY idx_audience_sessions_window (site_id, started_at, visitor_ref),
    -- Rattacher un événement à sa session ouverte, et purger par rétention.
    KEY idx_audience_sessions_recent (site_id, visitor_ref, last_at),
    KEY idx_audience_sessions_last (site_id, last_at),
    CONSTRAINT fk_audience_session_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
);

-- Un fait : des entiers et un horodatage. `kind` : 0 = vue de page, 1 =
-- événement nommé (TINYINT : la colonne entre dans l'index des classements).
CREATE TABLE IF NOT EXISTS audience_events (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    site_id    INT     NOT NULL,
    session_id BIGINT  NOT NULL,
    ts         BIGINT  NOT NULL,
    kind       TINYINT NOT NULL DEFAULT 0,
    path_id    INT     NULL,
    name_id    INT     NULL,
    -- Préfixe (site_id, ts) pour la fenêtre, puis `kind`, `path_id` et `name_id`
    -- en charge utile : les classements se lisent entièrement dans l'index.
    -- `name_id` y figure aussi pour le ménage des libellés orphelins, qui liste
    -- les libellés encore cités par un site sans retomber sur les lignes.
    KEY idx_audience_events_window (site_id, ts, kind, path_id, name_id),
    -- Les jointures vers la session, pour « visiteurs uniques par page ».
    KEY idx_audience_events_session (session_id),
    CONSTRAINT fk_audience_event_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE,
    CONSTRAINT fk_audience_event_session FOREIGN KEY (session_id) REFERENCES audience_sessions(id) ON DELETE CASCADE
);

-- L'agrégat journalier, jamais purgé : il fait survivre les courbes longues à
-- l'expiration des événements bruts (même partage qu'Uptime entre ses pings et
-- son agrégat). `day` en YYYYMMDD : un entier se compare, s'indexe et se lit
-- dans un dump.
CREATE TABLE IF NOT EXISTS audience_daily (
    site_id  INT NOT NULL,
    day      INT NOT NULL,
    views    INT NOT NULL DEFAULT 0,
    sessions INT NOT NULL DEFAULT 0,
    visitors INT NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, day),
    CONSTRAINT fk_audience_daily_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
);

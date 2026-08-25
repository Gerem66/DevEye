-- L'audience : ce que les gens font des projets une fois livrés.
--
-- Même forme que les dépôts git (064) et les bases de données (068), et pour
-- les mêmes raisons : un site suivi appartient à l'**espace**, plusieurs projets
-- peuvent pointer le même, et certains ne servent aucun projet. Il vit donc à
-- l'étage **ouvert** du chiffrement — l'ingestion tourne sans session, et c'est
-- le seul étage que le serveur sait relire seul.
--
-- ## Pourquoi si peu de colonnes sont chiffrées
--
-- Une statistique est un GROUP BY : rien de ce sur quoi on agrège ne peut être
-- chiffré, le chiffrement étant non déterministe. D'où `audience_labels`, qui
-- pousse le motif `*_ref` jusqu'au bout — le libellé chiffré y est stocké **une
-- fois**, et toutes les tables de faits ne portent que son identifiant entier.
-- On agrège sans clé, et l'on ne déchiffre que les quelques dizaines de
-- libellés qu'un écran affiche réellement.
--
-- Restent en clair sur le site : sa clé publique, ses origines autorisées, son
-- état et sa plateforme. Ce sont exactement les champs dont l'ingestion a besoin
-- pour router une requête sans session — et ils sont de toute façon lisibles
-- dans la page suivie, où la balise les expose.

CREATE TABLE IF NOT EXISTS audience_sites (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id   INT          NOT NULL,
    -- `pk_` + 24 caractères. **En clair et unique globalement** : c'est la seule
    -- chose dont dispose une requête d'ingestion pour retrouver son site, et
    -- elle arrive sans session, sans cookie et sans espace sur l'enveloppe.
    -- Publique par nature — elle est dans le HTML de la page suivie.
    public_key     CHAR(27)     NOT NULL,
    -- 16 premiers caractères du sha256 du nom en minuscules. Le chiffrement
    -- étant non déterministe, `content` ne peut porter aucune contrainte
    -- d'unicité — même motif que `slug_ref` (git) et `name_ref` (bases).
    name_ref       CHAR(16)     NOT NULL,
    -- 'web' | 'app' | 'both'. Décide si l'en-tête `Origin` est confronté aux
    -- origines autorisées : un client natif n'en envoie aucun, et refuser son
    -- absence lui fermerait la porte pour de bon.
    platform       VARCHAR(8)   NOT NULL DEFAULT 'web',
    -- Hôtes autorisés, séparés par des sauts de ligne. NULL ou vide = on accepte
    -- toute origine ; l'écran le signale comme un état transitoire, le temps de
    -- brancher, et non comme un réglage à laisser en place.
    origins        TEXT         NULL,
    -- Éteint, plus rien n'entre. L'historique déjà collecté ne bouge pas : il a
    -- été mesuré, il est vrai, et l'effacer serait mentir sur le passé.
    active         TINYINT      NOT NULL DEFAULT 1,
    -- Conservation des événements **bruts**. `audience_daily`, lui, survit.
    retention_days INT          NOT NULL DEFAULT 180,
    -- Rang dans la liste, entièrement défini par l'utilisateur.
    sort_order     INT          NOT NULL DEFAULT 0,
    -- Dernier événement reçu. NULL = jamais rien reçu, ce qui est l'état normal
    -- d'un site qu'on vient de déclarer — c'est ce que l'écran d'installation
    -- attend pour se déclarer satisfait, pas une panne.
    last_event_at  BIGINT       NULL,
    -- { name, description } chiffré, étage ouvert.
    content        TEXT         NOT NULL,
    created        BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_audience_site_key (public_key),
    UNIQUE KEY uniq_audience_site_name (workspace_id, name_ref),
    KEY idx_audience_sites_order (workspace_id, sort_order),
    CONSTRAINT fk_audience_site_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- La table de dimensions : un libellé chiffré, dédoublonné par son condensé.
--
-- C'est elle qui rend tout le reste possible. Un chemin vu mille fois y occupe
-- **une** ligne ; les tables de faits n'en portent que l'identifiant, donc un
-- événement pèse quelques dizaines d'octets et un classement se calcule sans
-- toucher à une clé de chiffrement.
--
-- `kind` reprend les valeurs d'`audienceDimensionSchema` : path, referrer,
-- browser, os, device, timezone, language, event, identity. Un seul vocabulaire
-- pour le stockage et pour l'axe demandé par `audience.breakdown` — deux listes
-- auraient divergé.
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
-- changent pas en cours de route.
--
-- Les porter ici plutôt que sur chaque événement est ce qui rend « combien de
-- visiteurs par navigateur » lisible d'une seule table, et divise d'autant le
-- volume : un visiteur qui parcourt trente pages ne décrit son navigateur, son
-- système et son fuseau qu'une fois.
--
-- `visitor_ref` = sha256(clé du site + IP + user-agent + sel du jour), tronqué.
-- **Ni l'IP ni le user-agent ne sont stockés**, et le sel tournant fait qu'un
-- même visiteur n'est pas reconnaissable d'un jour à l'autre. Pas de cookie,
-- donc rien à faire accepter par un bandeau de consentement.
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
    -- Décalage local du visiteur, en minutes. C'est lui, et non l'heure serveur,
    -- qui donne son sens à la carte d'activité : une audience répartie sur trois
    -- continents ne dessine rien en heure serveur.
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

-- Un fait, et rien d'autre : des entiers et un horodatage.
--
-- `kind` : 0 = vue de page, 1 = événement nommé. Un TINYINT plutôt qu'une chaîne
-- parce que cette colonne entre dans l'index de tous les classements.
CREATE TABLE IF NOT EXISTS audience_events (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    site_id    INT     NOT NULL,
    session_id BIGINT  NOT NULL,
    ts         BIGINT  NOT NULL,
    kind       TINYINT NOT NULL DEFAULT 0,
    path_id    INT     NULL,
    name_id    INT     NULL,
    -- L'index de tout : préfixe (site_id, ts) pour la fenêtre, puis `kind`,
    -- `path_id` et `name_id` en charge utile — le classement des pages comme
    -- celui des événements se lisent **entièrement dans l'index**, sans lire
    -- une seule ligne.
    --
    -- `name_id` y figure pour une seconde raison, moins évidente : le ménage
    -- des libellés orphelins doit pouvoir dresser la liste des libellés encore
    -- cités par un site. Sans lui, cette lecture retomberait sur les lignes et
    -- deviendrait la seule opération à coût non borné du module.
    KEY idx_audience_events_window (site_id, ts, kind, path_id, name_id),
    -- Les jointures vers la session, pour « visiteurs uniques par page ».
    KEY idx_audience_events_session (session_id),
    CONSTRAINT fk_audience_event_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE,
    CONSTRAINT fk_audience_event_session FOREIGN KEY (session_id) REFERENCES audience_sessions(id) ON DELETE CASCADE
);

-- L'agrégat journalier. **Jamais purgé.**
--
-- C'est lui qui fait survivre les courbes longues à l'expiration des événements
-- bruts — exactement le partage qu'Uptime opère déjà entre ses pings et son
-- agrégat journalier. Sans lui, régler la rétention à six mois effacerait
-- l'histoire d'un projet en même temps que le détail dont on n'a plus besoin.
--
-- `day` en YYYYMMDD : un entier se compare, s'indexe et se lit à l'œil nu dans
-- un dump, ce qu'une date SQL ne fait pas mieux ici.
CREATE TABLE IF NOT EXISTS audience_daily (
    site_id  INT NOT NULL,
    day      INT NOT NULL,
    views    INT NOT NULL DEFAULT 0,
    sessions INT NOT NULL DEFAULT 0,
    visitors INT NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, day),
    CONSTRAINT fk_audience_daily_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
);

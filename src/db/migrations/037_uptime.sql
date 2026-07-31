-- Uptime : suivi de disponibilité de services HTTP, avec historique long terme.
--
-- Découpage clair / chiffré (voir Docs/SECURITY_MODEL.md) : le planificateur
-- tourne en tâche de fond, sans session ni mot de passe — tout ce qui identifie
-- la cible (nom, URL, mot-clé attendu) et les messages d'erreur passent donc par
-- l'étage **ouvert** (`open_dek_wrapped`, toujours emballé par la clé serveur),
-- et seules les métadonnées nécessaires à la planification et aux graphiques
-- (cadence, état, latence, horodatages) restent en colonnes claires.
--
-- Trois niveaux d'historique, volontairement distincts :
--   * `uptime_checks`    — chaque ping, purgé selon `retention_days` du service
--                          (NULL = tout garder, valeur par défaut) ;
--   * `uptime_daily`     — agrégat journalier, **jamais purgé** : c'est lui qui
--                          permet de remonter des années même si le brut a été
--                          élagué, et qui rend un graphique « 1 an » gratuit ;
--   * `uptime_incidents` — les pannes (début / fin), jamais purgées non plus.

CREATE TABLE IF NOT EXISTS uptime_services (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    user_id              INT         NOT NULL,
    workspace_id         INT         NULL,
    -- { name, url, keyword } chiffré (étage ouvert).
    content              TEXT        NOT NULL,
    method               VARCHAR(8)  NOT NULL DEFAULT 'GET',
    -- NULL = n'importe quel 2xx/3xx convient.
    expected_status      INT         NULL,
    interval_seconds     INT         NOT NULL DEFAULT 60,
    timeout_seconds      INT         NOT NULL DEFAULT 10,
    failure_threshold    INT         NOT NULL DEFAULT 2,
    -- NULL = conserver tous les pings indéfiniment.
    retention_days       INT         NULL,
    notify               TINYINT     NOT NULL DEFAULT 1,
    enabled              TINYINT     NOT NULL DEFAULT 1,
    -- Rang dans la liste, entièrement défini par l'utilisateur (glisser-déposer),
    -- comme pour les notes. Rien ne le change automatiquement : seuls
    -- `uptime.reorder` et l'ajout d'un service (qui prend le rang suivant, donc
    -- la fin) y touchent.
    sort_order           INT         NOT NULL DEFAULT 0,
    status               VARCHAR(8)  NOT NULL DEFAULT 'unknown',
    consecutive_failures INT         NOT NULL DEFAULT 0,
    last_checked_at      BIGINT      NULL,
    last_response_ms     INT         NULL,
    last_http_status     INT         NULL,
    -- Message d'erreur chiffré (étage ouvert), NULL après un succès.
    last_error           TEXT        NULL,
    created              BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_uptime_services_user (user_id),
    -- Le planificateur ne lit que les services actifs, les plus en retard d'abord.
    KEY idx_uptime_services_due (enabled, last_checked_at),
    CONSTRAINT fk_uptime_service_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_uptime_service_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uptime_checks (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    service_id  INT     NOT NULL,
    checked_at  BIGINT  NOT NULL,
    up          TINYINT NOT NULL,
    http_status INT     NULL,
    response_ms INT     NULL,
    -- Message d'erreur chiffré (étage ouvert).
    error       TEXT    NULL,
    KEY idx_uptime_checks_service (service_id, checked_at),
    CONSTRAINT fk_uptime_check_service FOREIGN KEY (service_id) REFERENCES uptime_services(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uptime_daily (
    service_id INT    NOT NULL,
    -- Minuit UTC du jour agrégé, en secondes unix.
    day        BIGINT NOT NULL,
    checks     INT    NOT NULL DEFAULT 0,
    up_checks  INT    NOT NULL DEFAULT 0,
    -- Somme + nombre d'échantillons : la moyenne se recalcule sans perte au fil
    -- des upserts (un ping en échec n'a pas toujours de latence à compter).
    total_ms   BIGINT NOT NULL DEFAULT 0,
    ms_samples INT    NOT NULL DEFAULT 0,
    min_ms     INT    NULL,
    max_ms     INT    NULL,
    PRIMARY KEY (service_id, day),
    CONSTRAINT fk_uptime_daily_service FOREIGN KEY (service_id) REFERENCES uptime_services(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uptime_incidents (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    service_id  INT     NOT NULL,
    started_at  BIGINT  NOT NULL,
    -- NULL tant que la panne est en cours ; il n'y a qu'un incident ouvert par
    -- service à la fois (invariant tenu par src/Services/UptimeMonitor.ts).
    ended_at    BIGINT  NULL,
    http_status INT     NULL,
    -- Message d'erreur chiffré (étage ouvert).
    error       TEXT    NULL,
    -- La notification « down » a bien été envoyée (évite les doublons).
    notified    TINYINT NOT NULL DEFAULT 0,
    KEY idx_uptime_incidents_service (service_id, started_at),
    CONSTRAINT fk_uptime_incident_service FOREIGN KEY (service_id) REFERENCES uptime_services(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uptime_settings (
    user_id         INT     PRIMARY KEY,
    email_enabled   TINYINT NOT NULL DEFAULT 1,
    -- Destinataire chiffré (étage ouvert) ; NULL = l'adresse du compte.
    email_enc       TEXT    NULL,
    webhook_enabled TINYINT NOT NULL DEFAULT 0,
    -- URL de webhook chiffrée (étage ouvert).
    webhook_enc     TEXT    NULL,
    CONSTRAINT fk_uptime_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

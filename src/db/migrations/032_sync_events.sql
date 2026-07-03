-- CloudSync : journal d'événements par partage (erreurs de synchro, anomalies,
-- fichiers ignorés) — alimente la popup « Logs » de la feature. Purgé au-delà
-- de 90 jours par le prune horaire.
-- + politique de conflit par partage : `newest` (last-writer-wins, défaut) ou
-- `rename` (les deux contenus survivent, le perdant est renommé « (conflit …) »).

CREATE TABLE IF NOT EXISTS sync_events (
    id        BIGINT AUTO_INCREMENT PRIMARY KEY,
    share_id  INT           NOT NULL,
    device_id CHAR(36)      NULL,
    rel_path  VARCHAR(1024) NULL,
    message   VARCHAR(500)  NOT NULL,
    created   BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_sync_events_share (share_id, created),
    CONSTRAINT fk_sync_event_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_event_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
);

ALTER TABLE sync_shares
    ADD COLUMN conflict_policy VARCHAR(16) NOT NULL DEFAULT 'newest';

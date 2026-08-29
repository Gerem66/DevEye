-- Les canaux d'alerte, par feature. Sentinelle empruntait ceux d'Uptime : une
-- alerte de sécurité arrivait sur un salon désigné pour la disponibilité, sans
-- moyen de l'éteindre sans couper aussi Uptime. Le mécanisme reste commun, la
-- configuration se sépare : une table indexée par `(espace, feature)`.
-- `uptime_settings` est repris ici puis supprimé.

CREATE TABLE IF NOT EXISTS notification_settings (
    workspace_id    INT         NOT NULL,
    -- 'uptime' | 'sentinel' — `notificationFeatureSchema` côté contrats.
    feature         VARCHAR(24) NOT NULL,
    -- Éteint par défaut, contrairement à l'ancien réglage d'Uptime : rien ne
    -- part tant que personne ne l'a demandé.
    email_enabled   TINYINT     NOT NULL DEFAULT 0,
    -- Destinataire chiffré (étage ouvert) ; NULL = l'adresse du compte expéditeur.
    email_enc       TEXT        NULL,
    -- Le compte Mail qui envoie. Aucune FK : sa disparition ne doit pas effacer
    -- les réglages, le serveur vérifie l'appartenance et le palier à chaque
    -- résolution.
    mail_account_id INT         NULL,
    webhook_enabled TINYINT     NOT NULL DEFAULT 0,
    -- URL de webhook chiffrée (étage ouvert).
    webhook_enc     TEXT        NULL,
    PRIMARY KEY (workspace_id, feature),
    CONSTRAINT fk_notif_settings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Reprise des réglages existants d'Uptime, à l'identique : couper les alertes
-- de quelqu'un au passage d'une migration serait une surprise.
INSERT IGNORE INTO notification_settings
    (workspace_id, feature, email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc)
SELECT workspace_id, 'uptime', email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc
FROM uptime_settings;

DROP TABLE uptime_settings;

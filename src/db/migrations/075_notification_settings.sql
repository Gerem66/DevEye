-- Les canaux d'alerte, **par feature**.
--
-- Sentinelle empruntait ceux d'Uptime. L'intention était d'éviter deux jeux de
-- réglages à tenir à jour ; l'effet a été qu'une alerte de sécurité arrivait sur
-- un salon Discord désigné pour la disponibilité, sans que rien ne l'ait
-- annoncé, et sans moyen de l'éteindre sans couper aussi Uptime.
--
-- Le mécanisme reste commun (un compte mail « open », un webhook, la même
-- livraison) ; c'est la **configuration** qui se sépare. D'où une table unique
-- indexée par `(espace, feature)` plutôt qu'une table par émetteur : ajouter un
-- émetteur ne coûtera plus une migration.
--
-- `uptime_settings` est repris ici puis supprimé : deux tables jumelles auraient
-- dérivé dès la première évolution, et c'est exactement ce qu'on veut éviter.

CREATE TABLE IF NOT EXISTS notification_settings (
    workspace_id    INT         NOT NULL,
    -- 'uptime' | 'sentinel' — `notificationFeatureSchema` côté contrats.
    feature         VARCHAR(24) NOT NULL,
    -- Volontairement **éteint par défaut**, contrairement à l'ancien réglage
    -- d'Uptime : rien ne part tant que personne ne l'a demandé. Une feature qui
    -- se met à écrire à des gens sans qu'ils l'aient choisi est exactement le
    -- défaut qu'on corrige ici.
    email_enabled   TINYINT     NOT NULL DEFAULT 0,
    -- Destinataire chiffré (étage ouvert) ; NULL = l'adresse du compte expéditeur.
    email_enc       TEXT        NULL,
    -- Le compte Mail qui envoie. Aucune FK : il vit dans un autre espace de
    -- nommage et sa disparition ne doit pas effacer les réglages — le serveur
    -- vérifie l'appartenance et le palier à chaque résolution.
    mail_account_id INT         NULL,
    webhook_enabled TINYINT     NOT NULL DEFAULT 0,
    -- URL de webhook chiffrée (étage ouvert).
    webhook_enc     TEXT        NULL,
    PRIMARY KEY (workspace_id, feature),
    CONSTRAINT fk_notif_settings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Reprise des réglages existants d'Uptime, à l'identique. `email_enabled` garde
-- sa valeur d'origine : couper les alertes de quelqu'un au passage d'une
-- migration serait exactement le genre de surprise qu'on cherche à supprimer.
INSERT IGNORE INTO notification_settings
    (workspace_id, feature, email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc)
SELECT workspace_id, 'uptime', email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc
FROM uptime_settings;

DROP TABLE uptime_settings;

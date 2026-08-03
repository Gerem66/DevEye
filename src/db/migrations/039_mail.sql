-- Mail : boîtes IMAP/SMTP configurées par l'utilisateur, lues et envoyées
-- depuis DevEye.
--
-- Découpage clair / chiffré (voir Docs/SECURITY_MODEL.md) : contrairement à
-- Uptime/Password où l'étage de chiffrement est fixé une fois pour toutes par
-- la feature, ici c'est l'utilisateur qui choisit l'étage **par compte**
-- (`security_tier`, colonne claire — le serveur doit la lire avant de savoir
-- quel chiffreur utiliser). Un compte « open » peut être synchronisé et
-- utilisé en tâche de fond (ex. branché sur les alertes Uptime) ; un compte
-- « guarded » ne se déchiffre que pendant une session déverrouillée.
--
-- Les corps de message et pièces jointes ne sont **jamais** persistés — seule
-- l'enveloppe (sujet/expéditeur/destinataires/date/flags) est mise en cache
-- dans `mail_messages` pour un affichage de liste rapide ; le corps est
-- toujours récupéré en direct depuis IMAP à l'ouverture.

CREATE TABLE IF NOT EXISTS mail_accounts (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    user_id               INT          NOT NULL,
    sort_order            INT          NOT NULL DEFAULT 0,
    -- Chiffrés selon `security_tier` (étage ouvert ou étage mot de passe).
    display_name_enc      TEXT         NOT NULL,
    email_address_enc     TEXT         NOT NULL,
    security_tier         VARCHAR(8)   NOT NULL DEFAULT 'open',
    auth_method           VARCHAR(20)  NOT NULL DEFAULT 'password',
    enabled               TINYINT      NOT NULL DEFAULT 1,
    -- Rythme de relève en tâche de fond, propre à cette boîte : une boîte pro
    -- et une boîte d'archives n'ont aucune raison d'être relevées au même
    -- rythme. Ne concerne que les comptes « open » — les « guarded » ne sont
    -- jamais synchronisés en tâche de fond. La précision réelle reste bornée
    -- par MAIL_SYNC_TICK_SECONDS, rythme auquel le serveur cherche les comptes
    -- à relever.
    sync_interval_seconds INT          NOT NULL DEFAULT 600,
    last_sync_at          BIGINT       NULL,
    -- Chiffré selon `security_tier`, NULL après une synchro réussie.
    last_sync_error_enc   TEXT         NULL,
    -- Chiffré selon `security_tier` : { imap:{host,port,username,password},
    -- smtp:{...}, proxy? } (auth password) ou { provider, accessToken,
    -- refreshToken, expiresAt, scope } (auth OAuth). Jamais renvoyé au client.
    credentials_enc       TEXT         NOT NULL,
    created               BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_mail_accounts_user (user_id),
    -- Le service de synchro en tâche de fond ne lit que les comptes « open »
    -- actifs, les plus en retard d'abord — jamais les comptes « guarded ».
    KEY idx_mail_accounts_sync_due (enabled, security_tier, last_sync_at),
    CONSTRAINT fk_mail_account_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_folders (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    account_id     INT           NOT NULL,
    -- Clair : chemin IMAP de la boîte, nécessaire pour l'adresser sans déchiffrer.
    imap_path      VARCHAR(1024) NOT NULL,
    -- Chiffré selon l'étage du compte parent.
    name_enc       TEXT          NOT NULL,
    special_use    VARCHAR(16)   NOT NULL DEFAULT 'other',
    sort_order     INT           NOT NULL DEFAULT 0,
    -- UIDVALIDITY IMAP : un changement invalide tout le cache de ce dossier.
    uid_validity   BIGINT        NULL,
    -- Borne haute du cache : la synchro incrémentale va chercher au-delà.
    last_seen_uid  BIGINT        NULL,
    -- Borne basse du cache : `mail.folderBackfill` la fait descendre pour
    -- rattraper l'historique laissé hors de la fenêtre du premier sync (la
    -- synchro normale, strictement incrémentale, ne le ferait jamais).
    first_seen_uid BIGINT        NULL,
    unread_count   INT           NOT NULL DEFAULT 0,
    total_count    INT           NOT NULL DEFAULT 0,
    KEY idx_mail_folders_account (account_id),
    CONSTRAINT fk_mail_folder_account FOREIGN KEY (account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_messages (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    folder_id        INT     NOT NULL,
    uid              BIGINT  NOT NULL,
    -- Chiffré selon l'étage du compte parent : { subject, from, to, snippet }.
    -- Le corps du message n'est jamais stocké ici.
    envelope_enc     TEXT    NOT NULL,
    date             BIGINT  NOT NULL,
    seen             TINYINT NOT NULL DEFAULT 0,
    flagged          TINYINT NOT NULL DEFAULT 0,
    answered         TINYINT NOT NULL DEFAULT 0,
    has_attachments  TINYINT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_mail_messages_folder_uid (folder_id, uid),
    KEY idx_mail_messages_folder_date (folder_id, date),
    CONSTRAINT fk_mail_message_folder FOREIGN KEY (folder_id) REFERENCES mail_folders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_settings (
    user_id                        INT         PRIMARY KEY,
    -- Désactivé par défaut partout : opt-in, jamais poussé sur l'utilisateur.
    external_scan_enabled_default  TINYINT     NOT NULL DEFAULT 0,
    -- Liste JSON (tableau de chaînes) des noms d'hôte dont les images
    -- distantes se chargent automatiquement, sans repasser par le blocage par
    -- défaut — alimentée depuis la popup « sources d'images ». Non chiffré :
    -- ce ne sont que des noms d'hôte, pas des secrets.
    trusted_image_domains          TEXT        NULL,
    -- `embedded` (par défaut, rendu sanitizé inline dans le thème DevEye) ou
    -- `raw` (iframe sandboxée, fond blanc, CSS propre au message préservé).
    -- Voir `src/mail/sanitize.ts`.
    body_render_mode               VARCHAR(16) NOT NULL DEFAULT 'embedded',
    CONSTRAINT fk_mail_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

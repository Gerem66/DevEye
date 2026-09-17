-- Le serveur mail : les adresses hébergées, leurs dossiers et leurs messages,
-- la file d'envoi, les clés DKIM des domaines et le certificat des écouteurs.
--
-- L'adresse est en clair, et c'est délibéré : le routage d'un message entrant
-- part du destinataire, sans session ni clé, et une adresse est publique par
-- nature. Tout ce qui dit quelque chose d'une personne ou d'un message (nom
-- affiché, enveloppes, pairs d'une remise) est scellé dans `content` ou `meta`
-- sous le codec ouvert de l'espace. Les corps vivent hors base, en fichiers
-- chiffrés sous la clé de la boîte (`blob_key`, elle-même scellée).

CREATE TABLE IF NOT EXISTS ft_mailserver_mailboxes (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id         INT          NOT NULL,
    -- Le domaine du socle (feature_domains). Sans clé étrangère : la table
    -- appartient au socle, et le retrait d'un domaine ne retire pas ses boîtes.
    domain_id            INT          NOT NULL,
    local_part           VARCHAR(64)  NOT NULL,
    address              VARCHAR(320) NOT NULL,
    enabled              TINYINT(1)   NOT NULL DEFAULT 1,
    password_hash        VARCHAR(255) NOT NULL,
    password_set_at      BIGINT       NOT NULL,
    quota_bytes          BIGINT       NOT NULL,
    used_bytes           BIGINT       NOT NULL DEFAULT 0,
    message_count        INT          NOT NULL DEFAULT 0,
    outbound_daily_limit INT          NOT NULL DEFAULT 200,
    blob_key             TEXT         NOT NULL,
    -- Source des UIDVALIDITY des dossiers : ne redescend jamais, pour qu'un
    -- dossier supprimé puis recréé ne reprenne pas une valeur déjà vue.
    uid_validity_seq     INT UNSIGNED NOT NULL DEFAULT 1,
    banner_dismissed     TINYINT(1)   NOT NULL DEFAULT 0,
    last_delivery_at     BIGINT       NULL,
    last_login_at        BIGINT       NULL,
    content              TEXT         NOT NULL,
    created              BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_mailserver_mailboxes_address (address),
    KEY idx_ft_mailserver_mailboxes_ws (workspace_id),
    KEY idx_ft_mailserver_mailboxes_domain (domain_id),
    CONSTRAINT fk_ft_mailserver_mailboxes_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les mots de passe d'application : un par client, révocable sans toucher aux autres.
CREATE TABLE IF NOT EXISTS ft_mailserver_credentials (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    mailbox_id   INT          NOT NULL,
    label        VARCHAR(80)  NOT NULL,
    secret_hash  VARCHAR(255) NOT NULL,
    -- 'user' | 'mails'
    origin       VARCHAR(8)   NOT NULL DEFAULT 'user',
    -- Le serveur range lui-même une copie des envois : pour un client qui ne le fait pas.
    save_sent    TINYINT(1)   NOT NULL DEFAULT 0,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    created_by   INT          NOT NULL DEFAULT 0,
    last_used_at BIGINT       NULL,
    KEY idx_ft_mailserver_credentials_mailbox (mailbox_id),
    CONSTRAINT fk_ft_mailserver_credentials_mailbox FOREIGN KEY (mailbox_id) REFERENCES ft_mailserver_mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_mailserver_folders (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    mailbox_id   INT          NOT NULL,
    -- Sensible à la casse, sauf INBOX que le serveur normalise lui-même.
    path         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    -- '\Sent', '\Drafts', '\Trash', '\Junk', '\Archive', ou NULL
    special_use  VARCHAR(16)  NULL,
    uid_validity INT UNSIGNED NOT NULL,
    uid_next     INT UNSIGNED NOT NULL DEFAULT 1,
    subscribed   TINYINT(1)   NOT NULL DEFAULT 1,
    UNIQUE KEY uniq_ft_mailserver_folders_path (mailbox_id, path),
    CONSTRAINT fk_ft_mailserver_folders_mailbox FOREIGN KEY (mailbox_id) REFERENCES ft_mailserver_mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Un corps de message sur le disque. Compté par références : une copie IMAP
-- et la file d'envoi partagent le fichier au lieu de le dupliquer.
CREATE TABLE IF NOT EXISTS ft_mailserver_blobs (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    mailbox_id INT      NOT NULL,
    ref        CHAR(32) NOT NULL,
    size       INT      NOT NULL,
    refs       INT      NOT NULL DEFAULT 1,
    UNIQUE KEY uniq_ft_mailserver_blobs_ref (ref),
    KEY idx_ft_mailserver_blobs_mailbox (mailbox_id),
    CONSTRAINT fk_ft_mailserver_blobs_mailbox FOREIGN KEY (mailbox_id) REFERENCES ft_mailserver_mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_mailserver_messages (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    mailbox_id    INT          NOT NULL,
    folder_id     INT          NOT NULL,
    uid           INT UNSIGNED NOT NULL,
    -- Masque : 1 Seen, 2 Answered, 4 Flagged, 8 Deleted, 16 Draft
    flags         SMALLINT     NOT NULL DEFAULT 0,
    keywords      VARCHAR(255) NOT NULL DEFAULT '',
    internal_date BIGINT       NOT NULL,
    size          INT          NOT NULL,
    blob_id       BIGINT       NOT NULL,
    -- Scellé : enveloppe, structure MIME et positions des parties, calculées une fois.
    meta          MEDIUMTEXT   NOT NULL,
    UNIQUE KEY uniq_ft_mailserver_messages_uid (folder_id, uid),
    KEY idx_ft_mailserver_messages_mailbox (mailbox_id),
    KEY idx_ft_mailserver_messages_blob (blob_id),
    CONSTRAINT fk_ft_mailserver_messages_folder FOREIGN KEY (folder_id) REFERENCES ft_mailserver_folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- La file d'envoi : une ligne par destinataire, toutes partageant le même corps.
CREATE TABLE IF NOT EXISTS ft_mailserver_queue (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT         NOT NULL,
    mailbox_id      INT         NOT NULL,
    blob_id         BIGINT      NOT NULL,
    -- 'queued' | 'sending' | 'deferred'
    status          VARCHAR(10) NOT NULL DEFAULT 'queued',
    attempts        INT         NOT NULL DEFAULT 0,
    next_attempt_at BIGINT      NOT NULL,
    created         BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- Scellé : expéditeur, destinataire, dernière erreur.
    content         TEXT        NOT NULL,
    KEY idx_ft_mailserver_queue_due (status, next_attempt_at),
    KEY idx_ft_mailserver_queue_mailbox (mailbox_id),
    CONSTRAINT fk_ft_mailserver_queue_mailbox FOREIGN KEY (mailbox_id) REFERENCES ft_mailserver_mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_mailserver_domain_keys (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT          NOT NULL,
    host         VARCHAR(253) NOT NULL,
    selector     VARCHAR(32)  NOT NULL,
    -- Scellée sous la clé du serveur.
    private_key  TEXT         NOT NULL,
    -- La valeur `p=` publiée dans le DNS.
    public_key   TEXT         NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_mailserver_domain_keys_host (host),
    CONSTRAINT fk_ft_mailserver_domain_keys_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Le journal d'activité d'une boîte, borné par une rétention.
CREATE TABLE IF NOT EXISTS ft_mailserver_events (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    mailbox_id INT         NOT NULL,
    ts         BIGINT      NOT NULL,
    kind       VARCHAR(16) NOT NULL,
    size       INT         NOT NULL DEFAULT 0,
    -- 0 rien à juger, 1 réussi, 2 échoué
    spf        TINYINT     NOT NULL DEFAULT 0,
    dkim       TINYINT     NOT NULL DEFAULT 0,
    dmarc      TINYINT     NOT NULL DEFAULT 0,
    -- Scellé : le pair et le détail. Jamais le sujet d'un message.
    content    TEXT        NOT NULL,
    KEY idx_ft_mailserver_events_mailbox (mailbox_id, ts),
    KEY idx_ft_mailserver_events_ts (ts),
    CONSTRAINT fk_ft_mailserver_events_mailbox FOREIGN KEY (mailbox_id) REFERENCES ft_mailserver_mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les compteurs du graphique : ils survivent à la rétention du journal.
CREATE TABLE IF NOT EXISTS ft_mailserver_daily (
    mailbox_id INT     NOT NULL,
    -- AAAA-MM-JJ en UTC
    day        CHAR(10) NOT NULL,
    received   INT     NOT NULL DEFAULT 0,
    sent       INT     NOT NULL DEFAULT 0,
    rejected   INT     NOT NULL DEFAULT 0,
    bounced    INT     NOT NULL DEFAULT 0,
    PRIMARY KEY (mailbox_id, day),
    CONSTRAINT fk_ft_mailserver_daily_mailbox FOREIGN KEY (mailbox_id) REFERENCES ft_mailserver_mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Le compte ACME et le certificat des écouteurs, par nom d'hôte et par annuaire.
CREATE TABLE IF NOT EXISTS ft_mailserver_tls (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    hostname        VARCHAR(253) NOT NULL,
    -- 'account' | 'certificate'
    kind            VARCHAR(12)  NOT NULL,
    -- 'production' | 'staging'
    directory       VARCHAR(12)  NOT NULL,
    -- La clé privée, scellée sous la clé du serveur.
    sealed          TEXT         NOT NULL,
    cert_pem        MEDIUMTEXT   NULL,
    not_after       BIGINT       NULL,
    UNIQUE KEY uniq_ft_mailserver_tls (hostname, kind, directory)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- CloudSync : synchronisation de dossier type « Synology Drive ».
--
-- Les contenus de fichiers ne sont PAS en base : ils vivent dans un blob store
-- disque chiffré (clé serveur, voir src/cloudSync/blobCrypto.ts), adressés par
-- le SHA-256 de leur clair. Ici on ne garde que l'index : chemins, hashes,
-- tailles, mtimes, appareil source. Exception assumée au modèle zero-knowledge
-- (la synchro tourne en tâche de fond, session verrouillée ou non) — voir
-- Docs/SECURITY_MODEL.md.
--
-- Invariant central : sync_versions référence toujours un blob présent AVANT
-- qu'une ligne de sync_files ne soit écrasée/supprimée (archive-avant-
-- destruction, verrouillé dans src/cloudSync/versions.ts).
--
-- `rel_path` peut faire 1024 caractères : trop long pour un index unique
-- utf8mb4 → l'unicité passe par `rel_path_hash` (SHA-256 du chemin relatif
-- NFC-normalisé). Les mtimes de fichiers sont en millisecondes unix ; les
-- horodatages de lignes en secondes unix comme partout.

-- Métadonnées du sous-système (une ligne par clé) : la BMK wrappée y vit.
CREATE TABLE IF NOT EXISTS sync_meta (
    k VARCHAR(64) PRIMARY KEY,
    v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_shares (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    user_id              INT           NOT NULL,
    workspace_id         INT           NULL,
    name                 VARCHAR(120)  NOT NULL,
    storage_path         VARCHAR(1024) NOT NULL,
    status               VARCHAR(16)   NOT NULL DEFAULT 'active',
    backup_prune_enabled TINYINT       NOT NULL DEFAULT 0,
    backup_limit_bytes   BIGINT        NULL,
    created              BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated              BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_sync_shares_user (user_id),
    CONSTRAINT fk_sync_share_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_share_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_share_devices (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    share_id     INT           NOT NULL,
    device_id    CHAR(36)      NOT NULL,
    local_path   VARCHAR(1024) NOT NULL,
    status       VARCHAR(16)   NOT NULL DEFAULT 'active',
    last_sync_at BIGINT        NULL,
    created      BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_sync_share_device (share_id, device_id),
    KEY idx_sync_share_devices_device (device_id),
    CONSTRAINT fk_ssd_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE,
    CONSTRAINT fk_ssd_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_exclusions (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    share_id INT          NOT NULL,
    kind     VARCHAR(16)  NOT NULL,
    pattern  VARCHAR(512) NOT NULL,
    created  BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_sync_exclusions_share (share_id),
    CONSTRAINT fk_sync_exclusion_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE
);

-- Index canonique : l'état courant du « cloud », une ligne par chemin. Les
-- lignes `deleted` restent (elles portent la propagation de la suppression et
-- l'historique) ; leur contenu vit dans sync_versions.
CREATE TABLE IF NOT EXISTS sync_files (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    share_id         INT           NOT NULL,
    rel_path         VARCHAR(1024) NOT NULL,
    rel_path_hash    CHAR(64)      NOT NULL,
    hash             CHAR(64)      NOT NULL,
    size             BIGINT        NOT NULL,
    mtime            BIGINT        NOT NULL,
    source_device_id CHAR(36)      NULL,
    state            VARCHAR(16)   NOT NULL DEFAULT 'present',
    created          BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated          BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_sync_file (share_id, rel_path_hash),
    KEY idx_sync_files_hash (share_id, hash),
    CONSTRAINT fk_sync_file_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_file_device FOREIGN KEY (source_device_id) REFERENCES devices(id) ON DELETE SET NULL
);

-- Baseline par appareil : ce que l'appareil avait à la fin de sa dernière
-- session. C'est la 3e voie du merge — sans ligne ici, une absence locale est
-- un « jamais eu », jamais une suppression (donc premier sync = zéro perte).
CREATE TABLE IF NOT EXISTS sync_device_files (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    share_id      INT           NOT NULL,
    device_id     CHAR(36)      NOT NULL,
    rel_path      VARCHAR(1024) NOT NULL,
    rel_path_hash CHAR(64)      NOT NULL,
    hash          CHAR(64)      NOT NULL,
    size          BIGINT        NOT NULL,
    mtime         BIGINT        NOT NULL,
    synced_at     BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_sync_device_file (share_id, device_id, rel_path_hash),
    KEY idx_sync_device_files_device (device_id),
    CONSTRAINT fk_sdf_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE,
    CONSTRAINT fk_sdf_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Corbeille/versions : chaque écrasement, suppression, conflit ou restauration
-- archive ici le contenu précédent. Le blob (partagé par hash avec l'index
-- vivant) n'est physiquement détruit que lorsque plus rien ne le référence.
CREATE TABLE IF NOT EXISTS sync_versions (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    share_id         INT           NOT NULL,
    rel_path         VARCHAR(1024) NOT NULL,
    hash             CHAR(64)      NOT NULL,
    size             BIGINT        NOT NULL,
    mtime            BIGINT        NULL,
    source_device_id CHAR(36)      NULL,
    reason           VARCHAR(16)   NOT NULL,
    created          BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_sync_versions_share (share_id, created),
    KEY idx_sync_versions_hash (share_id, hash),
    CONSTRAINT fk_sync_version_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_version_device FOREIGN KEY (source_device_id) REFERENCES devices(id) ON DELETE SET NULL
);

-- Sessions de synchro (progression persistée ~2 s pour survivre à un reload ;
-- les sessions abandonnées passent en `error` au boot et au prune horaire).
CREATE TABLE IF NOT EXISTS sync_sessions (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    share_id    INT          NOT NULL,
    device_id   CHAR(36)     NOT NULL,
    state       VARCHAR(16)  NOT NULL DEFAULT 'scanning',
    files_total INT          NOT NULL DEFAULT 0,
    bytes_total BIGINT       NOT NULL DEFAULT 0,
    files_done  INT          NOT NULL DEFAULT 0,
    bytes_done  BIGINT       NOT NULL DEFAULT 0,
    error       VARCHAR(500) NULL,
    started     BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    finished    BIGINT       NULL,
    KEY idx_sync_sessions_share (share_id, started),
    CONSTRAINT fk_sync_session_share FOREIGN KEY (share_id) REFERENCES sync_shares(id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_session_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

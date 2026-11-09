-- Les tableaux blancs. Le titre (content) et la scene sont scelles a l etage
-- ouvert de l espace d origine, la scene compressee avant scellement. Les
-- tailles en clair servent au quota sans rien ouvrir.
CREATE TABLE IF NOT EXISTS ft_whiteboard_boards (
    id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT          NOT NULL,
    user_id         INT          NULL,
    updated_by      INT          NULL,
    content         TEXT         NOT NULL,
    scene           MEDIUMTEXT   NOT NULL,
    scene_bytes     INT UNSIGNED NOT NULL DEFAULT 0,
    version         INT UNSIGNED NOT NULL DEFAULT 0,
    preview         MEDIUMTEXT   NULL,
    preview_bytes   INT UNSIGNED NOT NULL DEFAULT 0,
    preview_version INT UNSIGNED NOT NULL DEFAULT 0,
    created         BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated         BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_ft_whiteboard_boards_ws (workspace_id, updated),
    CONSTRAINT fk_ft_whiteboard_boards_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les images collees dans un tableau. Les octets vivent dans le magasin
-- d objets sous object_key, tiree au sort, scelles par la cle du module.
-- orphaned_at marque une image qu aucun element ne reference plus : le
-- balayage la retire passe un jour.
CREATE TABLE IF NOT EXISTS ft_whiteboard_files (
    id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    board_id    INT          NOT NULL,
    file_id     VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    mime        VARCHAR(32)  NOT NULL,
    bytes       INT UNSIGNED NOT NULL,
    object_key  VARCHAR(48)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created     BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    orphaned_at BIGINT       NULL,
    UNIQUE KEY uniq_ft_whiteboard_files_board (board_id, file_id),
    UNIQUE KEY uniq_ft_whiteboard_files_object (object_key),
    KEY idx_ft_whiteboard_files_orphan (orphaned_at),
    CONSTRAINT fk_ft_whiteboard_files_board FOREIGN KEY (board_id) REFERENCES ft_whiteboard_boards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- La racine des cles du module (images), tiree au sort au premier demarrage et
-- scellee par la cle du serveur. Une seule ligne. La rotation de CRYPT_KEY_A/B
-- la re-emballe (le module la declare dans sealed) sans toucher aux images.
CREATE TABLE IF NOT EXISTS ft_whiteboard_key (
    id     TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
    sealed TEXT    NOT NULL,
    CONSTRAINT chk_ft_whiteboard_key_single CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

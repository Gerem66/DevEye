-- Les travaux de conversion, un fichier d'entrée pour un fichier de sortie, et
-- les taux de change du jour.
--
-- Aucun octet de fichier ne vit ici : ils sont sur le disque, sous un chemin
-- dérivé de (workspace_id, id), et la ligne ne porte que l'état.
--
-- Deux colonnes sont scellées sous le codec ouvert de l'espace : le nom du
-- fichier envoyé, qui dit souvent tout de son contenu, et le message d'un
-- échec, que l'outil de conversion rédige en citant ce qu'il lisait. Le reste
-- vient d'une liste fermée (famille, formats, état, cause d'échec) ou est un
-- nombre dont le tri et les sommes par espace ont besoin en SQL.

CREATE TABLE IF NOT EXISTS ft_convert_jobs (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    workspace_id      INT             NOT NULL,
    user_id           INT             NOT NULL,
    kind              ENUM('video', 'audio', 'image', 'document') NOT NULL,
    source_format     VARCHAR(16)     NOT NULL,
    target_format     VARCHAR(16)     NOT NULL,
    options           JSON            NOT NULL,
    original_name_enc TEXT            NOT NULL,
    -- La taille annoncée à l'ouverture du travail, puis la taille reçue : un
    -- envoi attendu pèse déjà sur la place que l'espace occupe.
    input_bytes       BIGINT UNSIGNED NOT NULL,
    output_bytes      BIGINT UNSIGNED NULL,
    phase             ENUM('awaiting_upload', 'uploading', 'queued', 'running',
                           'done', 'error', 'canceled', 'expired')
                      NOT NULL DEFAULT 'awaiting_upload',
    progress_permille SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    -- Combien de fois le travail est parti : un arrêt brutal du serveur le
    -- remet en file, mais pas indéfiniment.
    attempts          TINYINT UNSIGNED NOT NULL DEFAULT 0,
    error_code        VARCHAR(32)     NULL,
    error_enc         TEXT            NULL,
    created           BIGINT          NOT NULL,
    started_at        BIGINT          NULL,
    finished_at       BIGINT          NULL,
    -- Quand le résultat quitte le disque.
    expires_at        BIGINT          NULL,
    PRIMARY KEY (id),
    KEY idx_ft_convert_jobs_ws (workspace_id, created),
    KEY idx_ft_convert_jobs_phase (phase, created),
    KEY idx_ft_convert_jobs_expiry (phase, expires_at),
    CONSTRAINT fk_ft_convert_jobs_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les taux contre l'euro, sans workspace_id : la source publie les mêmes pour
-- tout le monde, et une parité est publique.
CREATE TABLE IF NOT EXISTS ft_convert_fx_rates (
    quote      CHAR(3)         NOT NULL,
    rate       DECIMAL(24, 10) NOT NULL,
    -- Le jour de publication chez la source, pas celui de la lecture : l'écran
    -- doit pouvoir dire de quand datent les taux un dimanche.
    as_of      CHAR(10)        NOT NULL,
    fetched_at BIGINT          NOT NULL,
    PRIMARY KEY (quote)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Une seule ligne. La dernière tentative se retient à part de la dernière
-- réussite : une source en panne ne doit pas être relancée à chaque tour.
CREATE TABLE IF NOT EXISTS ft_convert_fx_state (
    id              TINYINT UNSIGNED NOT NULL,
    last_attempt_at BIGINT           NOT NULL DEFAULT 0,
    last_success_at BIGINT           NOT NULL DEFAULT 0,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

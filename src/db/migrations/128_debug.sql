-- Les reglages de l'instance, ranges par origine publique : un serveur de dev
-- et la prod partagent parfois la meme base, et chacun ne lit que les siens.
CREATE TABLE IF NOT EXISTS instance_settings (
    name       VARCHAR(64)  NOT NULL,
    origin     VARCHAR(255) NOT NULL,
    value      TEXT         NOT NULL,
    updated    BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated_by INT          NULL,
    PRIMARY KEY (name, origin),
    CONSTRAINT fk_instance_settings_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les essais de la page Tests et debogage (bout en bout, mesures), elagues a
-- 100 par origine et par sorte. `started` et `finished` en millisecondes.
CREATE TABLE IF NOT EXISTS debug_runs (
    id       INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    origin   VARCHAR(255) NOT NULL,
    kind     ENUM('e2e', 'bench') NOT NULL,
    status   ENUM('running', 'passed', 'failed', 'aborted') NOT NULL DEFAULT 'running',
    started  BIGINT       NOT NULL,
    finished BIGINT       NULL,
    user_id  INT          NULL,
    report   MEDIUMTEXT   NOT NULL,
    KEY idx_debug_runs_origin_kind (origin, kind, id),
    CONSTRAINT fk_debug_runs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Un compte jetable d'un essai de bout en bout porte l'essai qui l'a cree
-- (etiquette d'instance, identifiant), pose une fois a la creation. NULL vaut
-- une personne. Conditionnel via INFORMATION_SCHEMA et SQL dynamique.
SET @users_e2e_run_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'e2e_run'
);
SET @add_users_e2e_run = IF(
    @users_e2e_run_exists = 0,
    'ALTER TABLE users ADD COLUMN e2e_run VARCHAR(48) NULL, ADD KEY idx_users_e2e_run (e2e_run)',
    'SELECT 1'
);
PREPARE stmt FROM @add_users_e2e_run;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

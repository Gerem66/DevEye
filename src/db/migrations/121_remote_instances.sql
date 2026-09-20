-- Les instances distantes d'un compte : d'autres serveurs DevEye dont il range
-- les espaces a cote des siens. Une adresse et un libelle, aucun secret : la
-- session de la-bas ne vit que dans le navigateur, et ce serveur ne contacte
-- jamais l'adresse.
CREATE TABLE IF NOT EXISTS remote_instances (
    id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    INT          NOT NULL,
    label      VARCHAR(60)  NOT NULL,
    origin     VARCHAR(255) NOT NULL,
    sort_order INT          NOT NULL DEFAULT 0,
    created    BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_remote_instance_origin (user_id, origin),
    KEY idx_remote_instances_user (user_id, sort_order),
    CONSTRAINT fk_remote_instance_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

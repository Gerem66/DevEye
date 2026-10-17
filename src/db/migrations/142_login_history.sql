-- Chaque connexion réussie du compte, pour qu'il repère celle d'un appareil
-- qui n'est pas le sien : le navigateur, l'adresse, les codes franchis et la
-- session ouverte. Le compte ne l'efface pas, seule la purge l'allège
-- (LOGIN_HISTORY_DAYS).
CREATE TABLE IF NOT EXISTS login_history (
    id BIGINT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    session_id CHAR(36) NOT NULL,
    label VARCHAR(120) NOT NULL,
    ip VARCHAR(45) NOT NULL,
    steps VARCHAR(32) NOT NULL,
    trusted TINYINT(1) NOT NULL,
    logged_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_login_history_user (user_id, logged_at),
    KEY idx_login_history_logged (logged_at),
    CONSTRAINT fk_login_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

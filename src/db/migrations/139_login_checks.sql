-- Une connexion depuis un navigateur que le compte ne connaît pas se confirme
-- par un code envoyé par mail, sauf si le compte l'a coupé. Actif pour tous les
-- comptes, existants compris.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB).

SET @users_login_email_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'login_email_check');
SET @add_users_login_email = IF(@users_login_email_exists = 0,
    'ALTER TABLE users ADD COLUMN login_email_check TINYINT(1) NOT NULL DEFAULT 1 AFTER step_up_interval',
    'SELECT 1');
PREPARE stmt FROM @add_users_login_email; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les navigateurs dont les connexions sautent ces codes : le condensé du jeton de
-- leur cookie, jamais le jeton, et ce qu'en dit leur User-Agent.
CREATE TABLE IF NOT EXISTS trusted_browsers (
    id BIGINT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    label VARCHAR(120) NOT NULL,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_trusted_browsers_token (token_hash),
    KEY idx_trusted_browsers_user (user_id),
    CONSTRAINT fk_trusted_browsers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

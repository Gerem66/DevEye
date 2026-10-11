-- Le numéro de téléphone d'un compte, pour le code par SMS à la connexion.
-- Scellé par la clé serveur sous le contexte de sa ligne : la connexion le lit
-- avant toute session. Une ligne n'existe qu'une fois le numéro vérifié par un
-- code reçu.
CREATE TABLE IF NOT EXISTS user_phones (
    user_id INT NOT NULL,
    phone_sealed TEXT NOT NULL,
    verified_at BIGINT NOT NULL,
    sms_check TINYINT(1) NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_user_phones_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

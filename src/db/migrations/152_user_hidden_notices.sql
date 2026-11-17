-- Les pages où un compte a fermé le bandeau « Aucune notification
-- configurée » : la liste d'une fonctionnalité dans un espace (item_id 0), ou
-- la fiche d'un élément. Le Profil les réaffiche toutes d'un coup.
CREATE TABLE IF NOT EXISTS user_hidden_notices (
    user_id INT NOT NULL,
    workspace_id INT NOT NULL,
    feature VARCHAR(32) NOT NULL,
    item_id INT NOT NULL DEFAULT 0,
    created BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (user_id, workspace_id, feature, item_id),
    KEY idx_user_hidden_notices_item (workspace_id, feature, item_id),
    CONSTRAINT fk_user_hidden_notices_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_user_hidden_notices_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

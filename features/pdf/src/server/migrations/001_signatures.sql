-- Les signatures que l'atelier garde sur le compte : un tracé, un nom
-- dans la police manuscrite, ou une image importée. Rangées dans l'espace
-- personnel du compte, et scellées sous son codec ouvert : une signature dit
-- qui l'on est.

CREATE TABLE IF NOT EXISTS ft_pdf_signatures (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    workspace_id INT             NOT NULL,
    user_id      INT             NOT NULL,
    role         ENUM('signature', 'initials') NOT NULL,
    data_enc     MEDIUMTEXT      NOT NULL,
    created      BIGINT          NOT NULL,
    PRIMARY KEY (id),
    KEY idx_ft_pdf_signatures_user (user_id, created),
    CONSTRAINT fk_ft_pdf_signatures_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

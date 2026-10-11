-- Une invitation à rejoindre un espace, adressée à une adresse (en minuscules)
-- et non à un compte : l'adresse n'en a pas forcément encore. Le rôle est celui
-- que l'invitant pouvait accorder au moment d'inviter. Une seule invitation
-- ouverte par adresse et par espace, qu'une réinvitation renouvelle.
CREATE TABLE IF NOT EXISTS workspace_invitations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT NOT NULL,
    email VARCHAR(320) NOT NULL,
    role_id INT NULL,
    invited_by INT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    UNIQUE KEY uniq_workspace_invitation (workspace_id, email),
    KEY idx_workspace_invitations_email (email),
    CONSTRAINT fk_invitation_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_invitation_role FOREIGN KEY (role_id) REFERENCES workspace_roles (id) ON DELETE SET NULL,
    CONSTRAINT fk_invitation_inviter FOREIGN KEY (invited_by) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

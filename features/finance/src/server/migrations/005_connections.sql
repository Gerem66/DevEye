-- Les connexions bancaires directes, et le compte du livre que chacune
-- alimente. Une connexion garde ses accès chiffrés à l'étage ouvert : le
-- service de fond la relève sans session. Retirer une connexion délie ses
-- comptes, sans toucher à ce qu'elle a déjà apporté au livre.

CREATE TABLE IF NOT EXISTS ft_finance_connections (
    id           INT          NOT NULL AUTO_INCREMENT,
    workspace_id INT          NOT NULL,
    -- 'qonto' ou 'enablebanking'.
    provider     VARCHAR(16)  NOT NULL,
    -- 'ok', 'error' ou 'expired'.
    status       VARCHAR(8)   NOT NULL DEFAULT 'ok',
    -- Ce que la dernière relève a buté, en une phrase écrite par le module.
    error        VARCHAR(300) NULL,
    -- La fin du consentement donné à la banque, en secondes Unix.
    valid_until  BIGINT       NULL,
    -- Le valid_until pour lequel l'avis d'expiration est parti : un seul avis par consentement.
    warned_until BIGINT       NULL,
    last_sync_at BIGINT       NULL,
    -- { label, bankName, secret, accounts } chiffré, étage ouvert.
    content      MEDIUMTEXT   NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (id),
    KEY idx_ft_finance_connections_ws (workspace_id, created),
    KEY idx_ft_finance_connections_due (status, last_sync_at),
    CONSTRAINT fk_ft_finance_connections_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_finance_bank_links (
    account_id          INT          NOT NULL,
    workspace_id        INT          NOT NULL,
    connection_id       INT          NOT NULL,
    -- L'identifiant du compte chez la banque, tel que la connexion le rend.
    external_account_id VARCHAR(100) NOT NULL,
    -- Le premier jour relevé : ce qui précède vient des imports ou du solde de départ.
    since               DATE         NOT NULL,
    created             BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (account_id),
    -- Un compte de la banque n'alimente qu'un compte du livre.
    UNIQUE KEY uniq_ft_finance_bank_links_remote (connection_id, external_account_id),
    KEY idx_ft_finance_bank_links_ws (workspace_id),
    CONSTRAINT fk_ft_finance_bank_links_account FOREIGN KEY (account_id) REFERENCES finance_accounts (id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_finance_bank_links_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_finance_bank_links_connection FOREIGN KEY (connection_id) REFERENCES ft_finance_connections (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

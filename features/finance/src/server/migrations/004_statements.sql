-- Les relevés bancaires : chaque import (avec le solde que donne la banque),
-- chaque ligne (une seule fois par compte, quel que soit le nombre d'imports
-- qui la contiennent), et les règles qui rangent une ligne toute seule.
-- Une ligne rapprochée pointe l'opération qu'elle confirme. Retirer cette
-- opération la renvoie à rapprocher, sans la perdre.

CREATE TABLE IF NOT EXISTS ft_finance_imports (
    id              INT         NOT NULL AUTO_INCREMENT,
    workspace_id    INT         NOT NULL,
    account_id      INT         NOT NULL,
    -- 'csv' ou 'ofx'.
    format          VARCHAR(8)  NOT NULL,
    first_date      DATE        NULL,
    last_date       DATE        NULL,
    line_count      INT         NOT NULL DEFAULT 0,
    new_count       INT         NOT NULL DEFAULT 0,
    -- Le solde que la banque annonce, et le jour où elle l'annonce, quand le fichier le porte.
    closing_balance BIGINT      NULL,
    closing_date    DATE        NULL,
    created         BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (id),
    KEY idx_ft_finance_imports_account (account_id, created),
    CONSTRAINT fk_ft_finance_imports_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_finance_imports_account FOREIGN KEY (account_id) REFERENCES finance_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_finance_statement_lines (
    id             INT          NOT NULL AUTO_INCREMENT,
    workspace_id   INT          NOT NULL,
    account_id     INT          NOT NULL,
    import_id      INT          NULL,
    -- L'identité de la ligne chez la banque : `ofx:<FITID>`, ou l'empreinte
    -- signée d'une ligne de CSV. C'est elle qui fait d'un second import un non-événement.
    external_id    VARCHAR(100) NOT NULL,
    date           DATE         NOT NULL,
    -- 'in' ou 'out'. Le montant reste positif, comme dans le livre.
    direction      VARCHAR(3)   NOT NULL,
    amount         BIGINT       NOT NULL,
    transaction_id INT          NULL,
    ignored        TINYINT      NOT NULL DEFAULT 0,
    -- { label, memo } chiffré, étage ouvert.
    content        TEXT         NOT NULL,
    created        BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (id),
    UNIQUE KEY uniq_ft_finance_lines_external (account_id, external_id),
    -- Un virement entre deux comptes du livre est une opération, confirmée par une ligne de chaque côté.
    UNIQUE KEY uniq_ft_finance_lines_tx (transaction_id, account_id),
    KEY idx_ft_finance_lines_pending (workspace_id, transaction_id, ignored, date),
    CONSTRAINT fk_ft_finance_lines_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_finance_lines_account FOREIGN KEY (account_id) REFERENCES finance_accounts (id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_finance_lines_import FOREIGN KEY (import_id) REFERENCES ft_finance_imports (id) ON DELETE SET NULL,
    CONSTRAINT fk_ft_finance_lines_tx FOREIGN KEY (transaction_id) REFERENCES finance_transactions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ft_finance_rules (
    id           INT        NOT NULL AUTO_INCREMENT,
    workspace_id INT        NOT NULL,
    -- 'in', 'out', ou NULL pour les deux sens.
    direction    VARCHAR(3) NULL,
    category_id  INT        NOT NULL,
    -- Le taux de TVA d'une dépense rangée par la règle, en points de base.
    vat_rate_bp  INT        NULL,
    sort_order   INT        NOT NULL DEFAULT 0,
    hits         INT        NOT NULL DEFAULT 0,
    -- { contains } chiffré : le texte cherché dans le libellé de la banque.
    content      TEXT       NOT NULL,
    created      BIGINT     NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (id),
    KEY idx_ft_finance_rules_ws (workspace_id, sort_order),
    CONSTRAINT fk_ft_finance_rules_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_finance_rules_category FOREIGN KEY (category_id) REFERENCES finance_categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Le statut de l'activité, qui dit ce qu'il faut mettre de côté : une
-- micro-entreprise (son activité, la cadence de ses déclarations, un taux
-- choisi à la place du taux légal, le versement libératoire), ou une
-- entreprise qui garde une part de son bénéfice. Le rôle d'une catégorie dit
-- ce qu'elle paie ou ce qu'elle rapporte : des cotisations, des impôts, de la
-- TVA, ou une recette hors chiffre d'affaires. Les rappels déjà envoyés sont
-- retenus pour ne jamais partir deux fois.
--
-- Rejouable : chaque ajout est gardé par la lecture d'INFORMATION_SCHEMA.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'finance_config'
              AND COLUMN_NAME = 'legal_status');
SET @s = IF(@has = 0,
    'ALTER TABLE finance_config ADD COLUMN legal_status VARCHAR(10) NULL, ADD COLUMN micro_activity VARCHAR(16) NULL, ADD COLUMN provision_rate_bp INT NULL, ADD COLUMN income_tax_prepaid TINYINT NOT NULL DEFAULT 0, ADD COLUMN declaration_period VARCHAR(10) NULL, ADD COLUMN tracking_since DATE NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'finance_categories'
              AND COLUMN_NAME = 'role');
SET @s = IF(@has = 0,
    'ALTER TABLE finance_categories ADD COLUMN role VARCHAR(10) NULL AFTER icon',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS ft_finance_reminders (
    workspace_id INT         NOT NULL,
    -- La déclaration rappelée, `2026-T3` ou `2026-09`.
    period_key   VARCHAR(10) NOT NULL,
    -- 'week' puis 'day' : une semaine, puis la veille de l'échéance.
    stage        VARCHAR(8)  NOT NULL,
    sent         BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (workspace_id, period_key, stage),
    CONSTRAINT fk_ft_finance_reminders_ws FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

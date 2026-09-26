-- Les finances de l'espace: comptes, opérations, budgets, échéances. Le livre
-- de comptes appartient à l'espace et vit à l'étage ouvert: la feature s'ouvre
-- sans mot de passe et tout membre lit les comptes.
--
-- Un solde est un `SUM(...) GROUP BY`: les nombres, les dates et les
-- rattachements restent en clair, seul le texte libre part dans `content`.
--
-- Les montants sont des entiers de centimes (`BIGINT`, jamais `DECIMAL` ni
-- `FLOAT`): l'addition est exacte par construction.
--
-- Les dates sont des `DATE`, pas des epoch: une opération appartient à un jour
-- civil, un epoch changerait de mois comptable selon le fuseau. Le dépôt
-- projette ces colonnes par `DATE_FORMAT(..., '%Y-%m-%d')`, sinon le pilote
-- rendrait un `Date` recalé sur le fuseau du serveur Node.
--
-- Les noms de contraintes sont uniques par schéma, d'où le préfixe `fk_fin_`.

-- Réglages de la feature, une ligne par espace. Créée à la demande par le
-- serveur (`ensureConfig`) plutôt qu'ici: une insertion pour chaque espace
-- existant poserait une ligne à des espaces qui n'ouvriront jamais la feature.
CREATE TABLE IF NOT EXISTS finance_config (
    workspace_id INT         NOT NULL PRIMARY KEY,
    -- Code ISO 4217. Une seule devise par espace: le multidevise demanderait un
    -- taux de change daté par opération.
    currency     CHAR(3)     NOT NULL DEFAULT 'EUR',
    -- Mode entreprise: fait apparaître la TVA sur les opérations et son
    -- récapitulatif sur le tableau de bord. Le seul commutateur entre l'usage
    -- particulier et l'usage PME.
    vat_enabled  TINYINT     NOT NULL DEFAULT 0,
    CONSTRAINT fk_fin_config_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS finance_accounts (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT          NOT NULL,
    -- 'checking' | 'savings' | 'cash' | 'other'. Sert l'icône de la carte, et
    -- le fait qu'une épargne soit comptée à part du disponible.
    kind            VARCHAR(16)  NOT NULL DEFAULT 'checking',
    -- Nom de la palette de thème (`--palette-<nom>`), jamais un hexadécimal:
    -- la valeur stockée reste liée au thème au lieu de jurer avec lui.
    color           VARCHAR(16)  NOT NULL DEFAULT 'blue',
    -- Solde avant toute opération enregistrée dans DevEye. Signé: on peut
    -- reprendre un compte à découvert.
    initial_balance BIGINT       NOT NULL DEFAULT 0,
    -- Mis de côté: sort des sélecteurs mais reste dans les totaux. C'est le
    -- geste réversible que `accountRemove` n'est pas.
    archived        TINYINT      NOT NULL DEFAULT 0,
    sort_order      INT          NOT NULL DEFAULT 0,
    -- { name, note } chiffré, étage ouvert.
    content         TEXT         NOT NULL,
    created         BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_finance_accounts_ws (workspace_id, archived, sort_order),
    CONSTRAINT fk_fin_account_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS finance_categories (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT          NOT NULL,
    -- 'expense' | 'income'. Une catégorie ne sert qu'un sens: « Salaire » ne
    -- classe pas une dépense, et proposer les deux dans un seul sélecteur
    -- transforme le choix en fouille.
    flow         VARCHAR(8)   NOT NULL DEFAULT 'expense',
    color        VARCHAR(16)  NOT NULL DEFAULT 'blue',
    -- Classe d'icône (`icons.css`), sans le préfixe `icon-`.
    icon         VARCHAR(40)  NOT NULL DEFAULT 'other',
    sort_order   INT          NOT NULL DEFAULT 0,
    -- { name } chiffré, étage ouvert.
    content      TEXT         NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_finance_categories_ws (workspace_id, flow, sort_order),
    CONSTRAINT fk_fin_category_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les échéances sont déclarées avant les opérations parce que celles-ci les
-- référencent (une opération sait de quelle échéance elle est née).
CREATE TABLE IF NOT EXISTS finance_recurring (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id        INT          NOT NULL,
    account_id          INT          NOT NULL,
    -- Le compte crédité, pour un virement seulement.
    transfer_account_id INT          NULL,
    category_id         INT          NULL,
    -- 'expense' | 'income' | 'transfer'
    kind                VARCHAR(16)  NOT NULL DEFAULT 'expense',
    amount              BIGINT       NOT NULL DEFAULT 0,
    -- Part de TVA du montant. Le taux n'est pas stocké: il se déduit, et le
    -- stocker ouvrirait la porte à un couple taux / montant incohérent que
    -- rien ne pourrait ensuite départager.
    vat_amount          BIGINT       NULL,
    -- 'weekly' | 'monthly' | 'quarterly' | 'yearly'
    frequency           VARCHAR(16)  NOT NULL DEFAULT 'monthly',
    -- « Tous les N » de la cadence. `interval` est un mot réservé de MySQL,
    -- d'où le suffixe.
    interval_count      INT          NOT NULL DEFAULT 1,
    next_date           DATE         NOT NULL,
    -- Jour du mois de la série (1 à 31), NULL pour une cadence hebdomadaire.
    -- Sans lui, une échéance au 31 dérive: février la ramène au 28, et elle y
    -- reste pour toujours parce que le calcul repart de la dernière date. Avec
    -- lui, on ajoute les mois puis on repose le jour d'ancrage, borné au
    -- dernier jour du mois d'arrivée. Dérivé de `next_date` à l'écriture, donc
    -- jamais renseigné par le client.
    anchor_day          TINYINT      NULL,
    end_date            DATE         NULL,
    last_posted_date    DATE         NULL,
    -- Écrit l'opération d'elle-même quand la date arrive (un salaire tombe
    -- qu'on regarde ou non), au lieu de la proposer et d'attendre un clic
    -- (une facture dont le montant varie).
    automatic           TINYINT      NOT NULL DEFAULT 0,
    -- Suspendue: plus rien n'est écrit ni proposé, sans rien perdre.
    active              TINYINT      NOT NULL DEFAULT 1,
    -- { label, counterparty, note } chiffré, étage ouvert.
    content             TEXT         NOT NULL,
    created             BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- La requête de rattrapage: « les échéances de cet espace qui ont une
    -- occurrence en retard ». Elle tourne en tête de chaque lecture, donc elle
    -- doit être servie par l'index et ne rien coûter quand il n'y a rien.
    KEY idx_finance_recurring_due (workspace_id, active, next_date),
    CONSTRAINT fk_fin_recurring_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_fin_recurring_account FOREIGN KEY (account_id) REFERENCES finance_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_fin_recurring_transfer FOREIGN KEY (transfer_account_id) REFERENCES finance_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_fin_recurring_category FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS finance_transactions (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id        INT          NOT NULL,
    account_id          INT          NOT NULL,
    -- Un virement est une ligne et non deux: elle porte son compte de départ
    -- (`account_id`) et son compte d'arrivée. Une paire à moitié supprimée
    -- ferait apparaître de l'argent.
    transfer_account_id INT          NULL,
    category_id         INT          NULL,
    -- L'échéance qui l'a engendrée. NULL pour une saisie à la main.
    recurring_id        INT          NULL,
    -- 'expense' | 'income' | 'transfer'. Le sens est porté par le kind et
    -- jamais par le signe du montant: un montant signé laisse exister « une
    -- dépense de -30 € », qui est une recette écrite de travers.
    kind                VARCHAR(16)  NOT NULL DEFAULT 'expense',
    amount              BIGINT       NOT NULL DEFAULT 0,
    vat_amount          BIGINT       NULL,
    date                DATE         NOT NULL,
    -- Vue sur le relevé de la banque. C'est ce que compte le solde pointé, et
    -- lui seul se compare au relevé.
    cleared             TINYINT      NOT NULL DEFAULT 0,
    -- { label, counterparty, note } chiffré, étage ouvert.
    content             TEXT         NOT NULL,
    created             BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated             BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- Le journal se lit toujours par espace et par date décroissante.
    KEY idx_finance_tx_ws_date (workspace_id, date, id),
    -- Les soldes agrègent par compte, des deux côtés d'un virement.
    KEY idx_finance_tx_account (account_id, date),
    KEY idx_finance_tx_transfer (transfer_account_id, date),
    KEY idx_finance_tx_category (category_id, date),
    -- Idempotence du rattrapage des échéances: une occurrence donnée ne peut
    -- exister qu'une fois. Deux lectures simultanées d'un même espace tomberaient
    -- sinon toutes deux sur la même échéance en retard et l'écriraient deux
    -- fois. MySQL admettant plusieurs NULL dans un index unique, les saisies à
    -- la main (`recurring_id IS NULL`) ne sont pas contraintes.
    UNIQUE KEY uniq_finance_tx_occurrence (recurring_id, date),
    CONSTRAINT fk_fin_tx_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_fin_tx_account FOREIGN KEY (account_id) REFERENCES finance_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_fin_tx_transfer FOREIGN KEY (transfer_account_id) REFERENCES finance_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_fin_tx_category FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL,
    -- L'échéance disparaît, l'opération reste: elle a eu lieu. Elle perd
    -- seulement son rattachement.
    CONSTRAINT fk_fin_tx_recurring FOREIGN KEY (recurring_id) REFERENCES finance_recurring(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS finance_budgets (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT          NOT NULL,
    category_id  INT          NOT NULL,
    amount       BIGINT       NOT NULL DEFAULT 0,
    -- 'monthly' | 'quarterly' | 'yearly'
    period       VARCHAR(16)  NOT NULL DEFAULT 'monthly',
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- Une seule enveloppe par catégorie: c'est ce qui rend `budgetSet` possible
    -- (pose ou remplace) plutôt qu'un couple ajout / modification.
    UNIQUE KEY uniq_finance_budget_category (category_id),
    KEY idx_finance_budgets_ws (workspace_id),
    CONSTRAINT fk_fin_budget_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_fin_budget_category FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

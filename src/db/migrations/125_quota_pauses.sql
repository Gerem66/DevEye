-- Ce que l'offre de son propriétaire tient en pause : les éléments d'une
-- limite de stock au-delà de la limite, les plus récents d'abord. Écrite par le
-- réconciliateur seul (`Services/planPauses.ts`), jamais par un module.
-- `item_id` est l'id de l'élément sous sa clé, en texte : un appareil a un UUID,
-- un membre s'écrit `<espace>:<compte>`.

CREATE TABLE IF NOT EXISTS quota_pauses (
    quota_key     VARCHAR(64) NOT NULL,
    item_id       VARCHAR(64) NOT NULL,
    owner_user_id INT         NOT NULL,
    workspace_id  INT         NOT NULL,
    created       BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (quota_key, item_id),
    KEY idx_quota_pauses_owner (owner_user_id),
    CONSTRAINT fk_quota_pauses_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_quota_pauses_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- L'instant où l'offre d'un compte change d'elle-même (un essai ou une offre
-- accordée qui prend fin), tel que le fournisseur l'annonce : le réconciliateur
-- repasse alors.
CREATE TABLE IF NOT EXISTS quota_rechecks (
    owner_user_id INT    NOT NULL PRIMARY KEY,
    due_at        BIGINT NOT NULL,
    KEY idx_quota_rechecks_due (due_at),
    CONSTRAINT fk_quota_rechecks_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

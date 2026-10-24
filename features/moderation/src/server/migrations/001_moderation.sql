-- Les listes de la moderation automatique et le journal de ce qu'elles ont
-- arrete. Rien ici n'appartient a un espace : une regle vaut pour toute
-- l'instance, et une detection ne garde l'espace et le compte d'origine que
-- pour l'administrateur.

-- Une regle : une empreinte (le SHA-256 d'un contenu, en hexadecimal
-- minuscule) ou un motif de nom (jokers * et ?). `pattern` est unique par
-- genre : la meme empreinte importee deux fois ne fait qu'une ligne.
-- `exposure` dit ou la regle s'applique : aux pages publiques seulement, ou
-- partout, stockage prive compris.
CREATE TABLE IF NOT EXISTS ft_moderation_rules (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    -- 'fingerprint' ou 'name'.
    kind            VARCHAR(12)  NOT NULL,
    pattern         VARCHAR(255) NOT NULL,
    -- Le motif d'interdiction, au vocabulaire des signalements.
    reason          VARCHAR(16)  NOT NULL,
    -- Ce que lit qui est arrete.
    label           VARCHAR(200) NOT NULL,
    -- 'public' ou 'everywhere'.
    exposure        VARCHAR(12)  NOT NULL DEFAULT 'everywhere',
    -- 'manual', 'takedown' ou 'feed'.
    source          VARCHAR(12)  NOT NULL DEFAULT 'manual',
    created_by      INT          NULL,
    hits            INT          NOT NULL DEFAULT 0,
    last_hit        BIGINT       NULL,
    created         BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_moderation_rule (kind, pattern),
    KEY idx_ft_moderation_rules_source (source, created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Une detection : un fichier qu'une regle a arrete dans une fonctionnalite.
-- Le nom du fichier et l'element qui le portait sont scelles par la cle du
-- serveur (`content`). Le meme fichier arrete plusieurs fois au meme endroit
-- (un appareil qui reessaie a chaque synchronisation) tient sur une ligne,
-- reconnue par `dedupe_key`, et `count` dit combien de fois.
-- La regle peut disparaitre : la ligne garde son genre, son motif et son
-- libelle. L'espace et le compte peuvent disparaitre aussi : la ligne reste,
-- anonyme.
CREATE TABLE IF NOT EXISTS ft_moderation_hits (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    feature         VARCHAR(32)  NOT NULL,
    rule_id         INT          NULL,
    kind            VARCHAR(12)  NOT NULL,
    reason          VARCHAR(16)  NOT NULL,
    label           VARCHAR(200) NOT NULL,
    content         TEXT         NOT NULL,
    sha256          CHAR(64)     NULL,
    size            BIGINT       NULL,
    workspace_id    INT          NULL,
    user_id         INT          NULL,
    dedupe_key      CHAR(64)     NOT NULL,
    count           INT          NOT NULL DEFAULT 1,
    first_seen      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    last_seen       BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_moderation_hit (dedupe_key),
    KEY idx_ft_moderation_hits_seen (last_seen),
    KEY idx_ft_moderation_hits_ws (workspace_id),
    CONSTRAINT fk_ft_moderation_hit_rule FOREIGN KEY (rule_id) REFERENCES ft_moderation_rules(id) ON DELETE SET NULL,
    CONSTRAINT fk_ft_moderation_hit_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
    CONSTRAINT fk_ft_moderation_hit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- L'etat de la liste externe : derniere importation, derniere erreur.
CREATE TABLE IF NOT EXISTS ft_moderation_meta (
    k               VARCHAR(64)  NOT NULL PRIMARY KEY,
    v               TEXT         NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

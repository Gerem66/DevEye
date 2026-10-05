-- Un élément visible depuis plusieurs espaces, sans jamais changer de clé.
--
-- Partager n'est pas déplacer : l'élément garde un seul domicile, reste chiffré
-- sous la clé de son espace d'origine, et se lit ailleurs avec le codec ouvert
-- de cet espace-là (voir `WORKSPACES.md` §8). C'est une projection, et cette
-- migration ne touche à aucun contenu.
-- Seule la clé de l'étage ouvert est résoluble par le serveur seul : un élément
-- de l'étage gardé ne peut pas être projeté. Le registre le porte dans
-- `shareTier`.

CREATE TABLE IF NOT EXISTS item_shares (
    -- L'espace **vers lequel** l'élément est projeté.
    workspace_id      INT         NOT NULL,
    feature           VARCHAR(24) NOT NULL,
    item_id           INT         NOT NULL,
    -- L'espace d'origine, celui dont la clé déchiffre l'élément. Redondant avec
    -- la table de l'élément, volontairement : la résolution du codec ne doit pas
    -- dépendre d'une jointure vers une table qui diffère selon la feature.
    home_workspace_id INT         NOT NULL,
    shared_by_user_id INT         NOT NULL,
    created           BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (workspace_id, feature, item_id),
    -- « Cet élément est-il projeté quelque part ? », posée à chaque affichage
    -- de sa fiche.
    KEY idx_item_shares_home (home_workspace_id, feature, item_id),
    CONSTRAINT fk_item_share_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    -- L'espace d'origine supprimé emporte ses projections : elles pointeraient
    -- sinon une clé qui n'existe plus, donc un élément définitivement illisible.
    CONSTRAINT fk_item_share_home FOREIGN KEY (home_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_item_share_user FOREIGN KEY (shared_by_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Aucune FK vers l'élément lui-même : il vit dans une table différente selon la
-- feature. Le nettoyage est applicatif, à la suppression de l'élément (même
-- choix que `notification_routes`, 087).

-- ## Les restrictions par élément
--
-- Restrictif seulement : `none` ou `read` abaissent ce que le rôle a sur la
-- fonctionnalité, rien n'élève (l'écran des rôles doit dire à lui seul qui voit
-- quoi). L'absence de ligne vaut « rien de particulier » : seules les
-- exceptions y figurent.

CREATE TABLE IF NOT EXISTS item_role_grants (
    -- L'espace depuis lequel la restriction s'applique : un élément projeté
    -- dans deux espaces peut y être restreint différemment.
    workspace_id INT         NOT NULL,
    feature      VARCHAR(24) NOT NULL,
    item_id      INT         NOT NULL,
    role_id      INT         NOT NULL,
    -- 'none' (masqué) | 'read' (lecture seule).
    access       VARCHAR(8)  NOT NULL,
    PRIMARY KEY (workspace_id, feature, item_id, role_id),
    KEY idx_item_grants_role (role_id),
    CONSTRAINT fk_item_grant_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    -- Le rôle supprimé emporte ses restrictions : une ligne orpheline
    -- s'appliquerait au prochain rôle qui hériterait de l'identifiant.
    CONSTRAINT fk_item_grant_role FOREIGN KEY (role_id) REFERENCES workspace_roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Aucune reprise : les deux tables naissent vides, et l'état vide est le
-- comportement d'avant.

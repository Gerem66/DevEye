-- Un élément visible depuis plusieurs espaces, sans jamais changer de clé.
--
-- ## Ce que ce n'est pas
--
-- `WORKSPACES.md` §10 range **déplacer** un élément d'un espace à un autre hors
-- périmètre, et la raison est juste : ce serait la seule opération du système à
-- exiger un déchiffrement clé A puis un re-chiffrement clé B sous session
-- vivante. Tout le reste est sans re-chiffrement — c'est le levier L3, et le
-- principal réducteur de risque du chantier des espaces.
--
-- Partager n'est pas déplacer. L'élément garde **un seul domicile** : il reste
-- chiffré sous la clé de son espace d'origine, et se lit ailleurs avec le codec
-- ouvert de cet espace-là. C'est une projection, pas un transfert, et c'est
-- pourquoi cette migration ne touche à aucun contenu.
--
-- ## Conséquence à assumer
--
-- Seule la clé de l'étage **ouvert** est résoluble par le serveur seul. Un
-- élément de l'étage gardé — une note privée, un compte mail « guarded », un
-- projet gardé — ne peut donc pas être projeté. Pas par prudence : par
-- impossibilité mécanique. Le registre le porte dans `shareTier`, et le serveur
-- le vérifie ligne à ligne pour les fonctionnalités où l'étage se choisit par
-- élément.

CREATE TABLE IF NOT EXISTS item_shares (
    -- L'espace **vers lequel** l'élément est projeté.
    workspace_id      INT         NOT NULL,
    feature           VARCHAR(24) NOT NULL,
    item_id           INT         NOT NULL,
    -- L'espace d'origine — celui dont la clé déchiffre l'élément. Redondant
    -- avec la colonne `workspace_id` de la table de l'élément, et c'est
    -- volontaire : la résolution du codec ne doit pas dépendre d'une jointure
    -- vers une table qui diffère selon la feature.
    home_workspace_id INT         NOT NULL,
    shared_by_user_id INT         NOT NULL,
    created           BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (workspace_id, feature, item_id),
    -- Sert la question chaude : « cet élément est-il projeté quelque part ? »,
    -- posée à chaque affichage de sa fiche.
    KEY idx_item_shares_home (home_workspace_id, feature, item_id),
    CONSTRAINT fk_item_share_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    -- L'espace d'origine supprimé emporte ses projections : elles pointeraient
    -- sinon une clé qui n'existe plus, donc un élément définitivement illisible.
    CONSTRAINT fk_item_share_home FOREIGN KEY (home_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_item_share_user FOREIGN KEY (shared_by_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Aucune FK vers l'élément lui-même : il vit dans une table différente selon la
-- feature (`uptime_services`, `database_connections`, `deploy_targets`…). Le
-- nettoyage est applicatif, à la suppression de l'élément — même choix que pour
-- `notification_routes` (migration 087).

-- ## Les restrictions par élément
--
-- **Restrictif seulement.** `none` ou `read` abaissent ce que le rôle a sur la
-- fonctionnalité ; rien n'élève. Le droit de feature reste le plafond, ici comme
-- pour les droits fins de la 088.
--
-- L'alternative — permettre d'élever — a été écartée : l'accès effectif à une
-- fonctionnalité deviendrait « le maximum entre le rôle et le meilleur droit
-- d'élément », donc une requête de plus dans la résolution d'accès, et surtout
-- un écran des rôles qui ne dirait plus à lui seul qui voit quoi.
--
-- L'**absence** de ligne vaut « rien de particulier ». C'est ce qui rend la
-- table petite : seules les exceptions y figurent, et un espace qui n'en pose
-- aucune n'y a aucune ligne.

CREATE TABLE IF NOT EXISTS item_role_grants (
    -- L'espace **depuis lequel** la restriction s'applique. Un élément projeté
    -- dans deux espaces peut y être restreint différemment : les rôles ne sont
    -- pas les mêmes des deux côtés, et une restriction posée chez l'un n'a pas
    -- à voyager chez l'autre.
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

-- Aucune reprise : les deux tables naissent vides, et c'est le comportement
-- d'avant. Un élément n'était visible que dans son espace, et aucun rôle n'y
-- était restreint — l'état vide **est** l'état actuel du système. Rien à
-- convertir, donc rien à risquer.

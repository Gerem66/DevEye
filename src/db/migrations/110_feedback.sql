-- Les signalements : un retour libre, ou un bug avec le rapport technique que
-- le client a rassemblé au moment de l'envoi.
--
-- En clair, et c'est délibéré. Le reste des données de feature passe par
-- `ctx.secure`, qui scelle avec la clé de leur propriétaire, et ici l'auteur
-- n'est pas le lecteur. Un signalement chiffré pour son auteur serait
-- illisible par l'administrateur, c'est-à-dire par la seule personne qui a
-- quelque chose à en faire. Même raisonnement que la table `logs`, dont
-- celle-ci est la voisine par nature.
--
-- Aucune clé étrangère, pour la même raison que `logs` : un signalement est un
-- fait daté, il ne disparaît pas avec le compte qui l'a écrit ni avec l'espace
-- d'où il a été envoyé. Les jointures sont des LEFT JOIN et l'affichage
-- retombe sur l'identifiant quand le compte n'existe plus.
--
-- Deux index seulement : la table reste petite par construction, un humain
-- écrit chaque ligne. `created` sert le listage, `(uid, created)` le plafond
-- horaire qui borne les envois d'un même compte.

CREATE TABLE IF NOT EXISTS feedback (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    -- L'auteur, résolu par la session : jamais une valeur venue du client.
    uid          INT          NOT NULL,
    -- L'espace ouvert au moment de l'envoi. Contexte seulement, jamais une
    -- portée : un signalement ne se range pas dans un espace.
    workspace_id INT          NULL,
    -- 'general' | 'bug'
    kind         VARCHAR(16)  NOT NULL,
    message      TEXT         NOT NULL,
    -- Le rapport technique d'un bug, tel que décrit par `feedbackSnapshotSchema`.
    -- NULL pour un retour libre, qui n'en porte jamais.
    snapshot     JSON         NULL,
    -- 'new' | 'open' | 'done'
    status       VARCHAR(16)  NOT NULL DEFAULT 'new',
    ip           VARCHAR(64)  NOT NULL DEFAULT '',
    -- La version du serveur à l'envoi. Celle du client vit dans le rapport :
    -- les deux diffèrent quand un onglet a traversé un déploiement, ce qui
    -- explique à soi seul toute une classe de bugs.
    app_version  VARCHAR(32)  NOT NULL DEFAULT '',
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    handled_at   BIGINT       NULL,
    handled_by   INT          NULL,
    KEY idx_feedback_created (created),
    KEY idx_feedback_uid_created (uid, created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

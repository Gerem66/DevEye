-- Sentinelle : ligne de base, constats, autorisations.
--
-- Rien ici n'est chiffré, comme `devices.report_json` : le moteur tourne sans
-- session et sans mot de passe, et ces données décrivent des machines, pas des
-- secrets d'utilisateur (voir `Docs/SECURITY_MODEL.md`).
-- Un défaut de posture (pare-feu éteint, SSH qui accepte root) est un constat
-- comme un autre : il entre dans `device_findings`, avec le même cycle de vie et
-- le même chemin de notification.

-- La ligne de base : ce qui a été observé, une ligne par (appareil, nature,
-- élément). Elle ne grandit plus une fois la machine connue.
--
-- La collation de `device_id` est héritée, jamais déclarée : une clé étrangère
-- exige que les deux colonnes partagent jeu de caractères et collation, et
-- `devices.id` est un `CHAR(36)` nu qui porte le défaut de la base, quel qu'il
-- soit (`utf8mb4_0900_ai_ci` sur MySQL 8 récent, `utf8mb4_general_ci` ailleurs).
CREATE TABLE IF NOT EXISTS device_baseline (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id  CHAR(36) NOT NULL,
    -- 'process' | 'listener' | 'persistence' | 'account'
    kind       VARCHAR(24)  NOT NULL,
    -- Clé lisible de l'élément : 'nginx|/usr/sbin/nginx', 'tcp/0.0.0.0:22',
    -- '/etc/cron.d/backup'. Gardée telle quelle pour l'affichage.
    item_key   VARCHAR(512) NOT NULL,
    -- sha256(item_key). L'unicité porte sur l'empreinte et non sur la clé :
    -- un chemin de 512 caractères en utf8mb4 pèse 2048 octets, et l'index
    -- composé dépasserait alors la limite InnoDB de 3072. L'empreinte fixe le
    -- coût à 32 octets quelle que soit la longueur du chemin.
    item_hash  BINARY(32)   NOT NULL,
    -- Unix ms, comme `device_metrics.ts` : une entrée de ligne de base se
    -- rapproche d'un instant, deux unités dans la même feature fausseraient les
    -- comparaisons.
    first_seen BIGINT       NOT NULL,
    last_seen  BIGINT       NOT NULL,
    -- Nombre d'instants où l'élément a été vu. Sert à distinguer un programme
    -- installé d'un programme aperçu une fois.
    samples    INT UNSIGNED NOT NULL DEFAULT 1,
    -- { users, listenPorts, cpuP95, memP95, sha256, surface }. Une colonne JSON
    -- plutôt que six : ces attributs n'entrent dans aucune clause WHERE, ils ne
    -- servent qu'à comparer l'instant courant à l'habitude.
    attrs      JSON         NOT NULL,
    UNIQUE KEY uq_baseline_item (device_id, kind, item_hash),
    -- Le balayage « qu'est-ce qui a disparu » lit cet index seul.
    KEY idx_baseline_seen (device_id, kind, last_seen),
    CONSTRAINT fk_baseline_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Les constats : un écart jugé digne d'être montré. `state` porte l'état courant
-- en clair, comme `database_alerts.firing` : c'est ce qui permet de ne notifier
-- qu'aux transitions plutôt qu'à chaque tour.
CREATE TABLE IF NOT EXISTS device_findings (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    -- Collation héritée pour la même raison que sur `device_baseline`.
    device_id   CHAR(36) NOT NULL,
    -- Identifiant de règle du catalogue figé (`sentinelRuleIdSchema`).
    rule        VARCHAR(48)  NOT NULL,
    -- sha256(rule + subject). Un constat par situation, pas un par tour : une
    -- ligne dont le compteur monte, au lieu de mille quatre cents par jour.
    dedup_hash  BINARY(32)   NOT NULL,
    -- 1 info | 2 low | 3 high | 4 critical. Le **rang** et non le nom : trier
    -- sur 'critical' < 'low' en ordre lexical remonterait l'inverse de l'urgence.
    severity    TINYINT      NOT NULL,
    -- 'open' | 'acknowledged' | 'resolved'
    state       VARCHAR(16)  NOT NULL DEFAULT 'open',
    -- Ce sur quoi porte le constat, en clair : c'est la clé machine que les
    -- autorisations réutilisent, d'où son absence du blob de preuve.
    subject     VARCHAR(512) NOT NULL,
    -- Paires libellé/valeur déjà mises en forme par le serveur, figées au
    -- premier déclenchement : l'interface n'a aucun rendu par règle à écrire.
    evidence    JSON         NOT NULL,
    -- L'instant épinglé qui porte la preuve (unix ms), ou NULL pour les
    -- constats qui ne naissent pas d'un instant (posture, persistance, auth).
    snapshot_ts BIGINT       NULL,
    first_seen  BIGINT       NOT NULL,
    last_seen   BIGINT       NOT NULL,
    occurrences INT UNSIGNED NOT NULL DEFAULT 1,
    -- Une notification est partie pour ce constat. Empêche la re-notification
    -- d'un constat qui rouvre et se referme en boucle.
    notified    TINYINT      NOT NULL DEFAULT 0,
    acked_by    INT          NULL,
    acked_at    BIGINT       NULL,
    UNIQUE KEY uq_finding_dedup (device_id, dedup_hash),
    -- La liste par défaut : les constats ouverts d'un appareil, au pire d'abord.
    KEY idx_finding_open (device_id, state, severity),
    -- Le balayage des constats résolus, et lui seul, lit celui-ci.
    KEY idx_finding_prune (state, last_seen),
    CONSTRAINT fk_finding_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_finding_acked_by FOREIGN KEY (acked_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Les autorisations : les décisions humaines, rangées à part de la ligne de
-- base. Celle-ci est reconstructible (`sentinel.resetBaseline`), les décisions
-- ne le sont pas.
CREATE TABLE IF NOT EXISTS sentinel_allowlist (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT          NOT NULL,
    -- NULL = toute la flotte de l'espace, y compris les machines qui le
    -- rejoindront plus tard (« ce programme est notre agent de sauvegarde »).
    -- Collation héritée pour la même raison que sur `device_baseline`.
    device_id    CHAR(36) NULL,
    rule         VARCHAR(48)  NOT NULL,
    subject      VARCHAR(512) NOT NULL,
    -- Même raison que `device_baseline.item_hash` : l'unicité porte sur
    -- l'empreinte, la colonne lisible sert à l'affichage.
    subject_hash BINARY(32)   NOT NULL,
    reason       VARCHAR(255) NULL,
    created_by   INT          NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uq_allow (workspace_id, device_id, rule, subject_hash),
    -- Le moteur consulte cette liste avant d'émettre : une lecture par appareil
    -- et par tour, d'où l'index sur le couple de portées.
    KEY idx_allow_lookup (workspace_id, rule),
    CONSTRAINT fk_allow_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_allow_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_allow_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Réglages par appareil. Éteint par défaut, comme le relevé des bases (068) :
-- activer une feature ne doit lire les journaux d'authentification de personne.
ALTER TABLE devices
    ADD COLUMN sentinel_enabled TINYINT NOT NULL DEFAULT 0,
    -- Fin de la fenêtre d'apprentissage, unix ms. Pendant qu'elle court, tout
    -- est absorbé dans la ligne de base et les règles de dérive restent muettes
    -- (sinon le premier jour produirait des centaines de « nouveau programme »).
    ADD COLUMN sentinel_learning_until BIGINT NULL,
    -- Cadence du manifeste de persistance, en minutes. Séparée de
    -- `metric_interval_seconds` : empreinter cinq cents fichiers ne se fait pas
    -- au rythme d'un relevé CPU.
    ADD COLUMN sentinel_integrity_minutes INT NOT NULL DEFAULT 360,
    -- Le relevé d'authentification, réglable à part : c'est la sonde la plus
    -- sensible, elle mérite son propre interrupteur.
    ADD COLUMN sentinel_auth_events TINYINT NOT NULL DEFAULT 1,
    -- Unix ms du dernier manifeste reçu. Sert à dire « pas encore mesuré »
    -- plutôt qu'à afficher un vert qui ne repose sur rien.
    ADD COLUMN sentinel_last_integrity_at BIGINT NULL;

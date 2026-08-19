-- Sauvegardes: les destinations de l'espace, les travaux qui y écrivent, et
-- l'historique de ce qui est réellement parti.
--
-- Même famille que les dépôts git (064), les bases (068), l'audience (076) et
-- les cibles de déploiement (080): l'objet appartient à l'**espace**, jamais à
-- un projet, et vit **toujours** à l'étage ouvert du chiffrement. Ce n'est pas
-- un choix de rangement mais une contrainte: l'ordonnanceur passe à 3 h du
-- matin, sans session ni mot de passe. Un secret S3 qu'il ne pourrait pas lire
-- serait un travail qui ne part jamais.
--
-- ## Trois tables, parce qu'il y a trois durées de vie
--
-- Une **destination** survit à tous les travaux qui la visent; un **travail**
-- survit à toutes ses exécutions; une **exécution** est un fait daté qu'on ne
-- réécrit jamais. Les fondre (« un travail porte son endpoint ») obligerait à
-- ressaisir la clé secrète à chaque nouveau travail et à la corriger à N
-- endroits le jour où elle tourne.
--
-- ## Ce qui reste en clair, et pourquoi si peu
--
-- `kind`, `device_id`, `source_kind`, les drapeaux et le calendrier: le strict
-- nécessaire pour que l'ordonnanceur choisisse une branche de code et trouve les
-- travaux dus **sans déchiffrer une seule ligne**. Tout le reste — nom, chemin,
-- endpoint, bucket, identifiant d'accès, message d'erreur, nom de l'archive —
-- part dans `content`. L'adresse d'un bucket dit où sont les copies de tout ce
-- que DevEye détient; ce n'est pas une métadonnée de tri.
--
-- ⚠️ Six colonnes chiffrées à déclarer dans `workspaceRekey`:
-- `backup_destinations.content`, `backup_destinations.secret_enc`,
-- `backup_jobs.content`, `backup_runs.content`. En oublier une la rendrait
-- illisible après une conversion de clé d'espace, et la sauvegarde continuerait
-- de tourner en écrivant sous un nom qu'on ne saurait plus relire.
--
-- ⚠️ Les noms de contraintes sont uniques **par schéma** et non par table, d'où
-- le préfixe `fk_bkp_` sur toutes celles d'ici (`fk_bd_`/`fk_bj_` auraient pu
-- entrer en collision avec les bases et les budgets).
--
-- ⚠️⚠️ **La clé étrangère vers `devices` est posée à part, après un alignement de
-- collation.** C'est le prolongement du piège documenté par la migration `080`,
-- appliqué cette fois à une colonne **texte**, où il mord bien plus fort :
--
--   - `devices` (migration `004`) est créée **sans clause de collation** : elle
--     hérite donc du défaut de la *base*, qui vaut `utf8mb4_general_ci` sur les
--     installations existantes de ce dépôt mais `utf8mb4_0900_ai_ci` sur une
--     base créée par un MySQL 8 récent ;
--   - ce fichier déclare `utf8mb4_general_ci`, comme `080` a appris à le faire.
--
-- Les deux ensemble donnent, sur une installation neuve, un `device_id` en
-- `general_ci` pointant un `devices.id` en `0900_ai_ci`. InnoDB **refuse** une
-- clé étrangère entre deux colonnes de collations différentes (errno 3780), et
-- la jointure `LEFT JOIN devices ON dev.id = d.device_id` du dépôt lèverait de
-- toute façon « Illegal mix of collations ». Le refus tomberait au démarrage,
-- hors transaction, sur la toute première instance installée à neuf — c'est-à-
-- dire chez quelqu'un d'autre, jamais en développement.
--
-- On aligne donc `device_id` sur ce que `devices.id` vaut **réellement**, lu
-- dans `INFORMATION_SCHEMA`, avant de poser la contrainte.

-- Où les archives atterrissent. Trois genres derrière une seule table, parce
-- qu'ils répondent tous à la même question et se choisissent dans le même
-- sélecteur — un travail ne veut savoir qu'une chose de sa destination: sait-elle
-- accepter des octets.
CREATE TABLE IF NOT EXISTS backup_destinations (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT         NOT NULL,
    -- 'local' | 'device' | 's3'
    kind         VARCHAR(16) NOT NULL,
    -- 'device' uniquement: la machine dont l'agent écrit le fichier. NULL quand
    -- l'appareil est supprimé — la destination reste, inutilisable, et le dit,
    -- plutôt que d'emporter les travaux qui la visaient.
    device_id    CHAR(36)    NULL,
    -- S3: adressage par chemin (`https://hôte/bucket/clé`) plutôt que par
    -- sous-domaine. Vrai pour Garage et MinIO, faux pour AWS. En clair parce que
    -- c'est un commutateur de code, pas une donnée.
    path_style   TINYINT     NOT NULL DEFAULT 1,
    -- Les archives sont-elles scellées avant d'être écrites ? Défaut à 1: dès
    -- que les octets quittent le serveur, ils doivent être illisibles pour qui
    -- tient le disque d'en face.
    encrypt      TINYINT     NOT NULL DEFAULT 1,
    -- 'unknown' | 'ok' | 'error' — le verdict du dernier contrôle d'écriture.
    status       VARCHAR(16) NOT NULL DEFAULT 'unknown',
    checked_at   BIGINT      NULL,
    -- { name, path, endpoint, region, bucket, accessKeyId, lastError } chiffré.
    content      TEXT        NOT NULL,
    -- Clé secrète S3. Chaîne vide pour 'local' et 'device', qui n'en ont pas.
    secret_enc   TEXT        NOT NULL,
    created      BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_backup_destinations_workspace (workspace_id),
    KEY idx_backup_destinations_device (device_id),
    CONSTRAINT fk_bkp_dest_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Aligner `device_id` sur la collation réelle de `devices.id` (voir l'avertissement
-- en tête). Interpolée depuis `INFORMATION_SCHEMA`, donc jamais depuis une donnée
-- reçue. Idempotent : réappliquer la même collation est un no-op côté MySQL.
SET @dev_collation = (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'id');
SET @s = CONCAT('ALTER TABLE backup_destinations MODIFY COLUMN device_id CHAR(36) COLLATE ',
                COALESCE(@dev_collation, 'utf8mb4_general_ci'), ' NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La contrainte, une fois les collations d'accord. Guardée pour le rejeu : les
-- migrations tournent hors transaction, et un fichier interrompu se rejoue depuis
-- le début — un `ADD CONSTRAINT` non gardé échouerait alors sur un nom déjà pris.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_destinations'
             AND CONSTRAINT_NAME = 'fk_bkp_dest_device');
SET @s = IF(@c = 0,
    'ALTER TABLE backup_destinations ADD CONSTRAINT fk_bkp_dest_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Quoi part, où, quand, et combien de copies on garde.
CREATE TABLE IF NOT EXISTS backup_jobs (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id     INT         NOT NULL,
    -- RESTRICT et non CASCADE: supprimer une destination encore visée laisserait
    -- soit des travaux orphelins (qui ne peuvent ni s'exécuter ni l'annoncer),
    -- soit une cascade qui efface silencieusement la configuration de quelqu'un.
    -- On refuse, et l'écran dit combien de travaux il faut trancher d'abord.
    destination_id   INT         NOT NULL,
    -- 'database' | 'deveye' | 'cloudsync'
    source_kind      VARCHAR(16) NOT NULL,
    -- La connexion supervisée ou le partage CloudSync visé. NULL pour 'deveye',
    -- qui est unique par nature. Volontairement **sans** clé étrangère: elle
    -- pointerait deux tables différentes selon `source_kind`, ce qu'InnoDB ne
    -- sait pas exprimer. La source disparue est détectée à l'exécution, qui
    -- échoue en le disant — et l'historique déjà écrit survit, ce qu'une
    -- cascade aurait détruit.
    source_id        INT         NULL,
    enabled          TINYINT     NOT NULL DEFAULT 1,
    -- 'manual' | 'hourly' | 'daily' | 'weekly' | 'monthly'
    schedule_kind    VARCHAR(16) NOT NULL DEFAULT 'daily',
    -- Heure locale du serveur. 3 h par défaut: assez tard pour que la journée
    -- soit finie, assez tôt pour qu'un échec se voie au réveil.
    schedule_hour    TINYINT     NOT NULL DEFAULT 3,
    -- 0 = dimanche, comme `Date.getDay()`.
    schedule_weekday TINYINT     NOT NULL DEFAULT 0,
    -- Borné à 28 côté contrat: un travail mensuel au 31 ne partirait pas en
    -- février, ce qui est le genre de silence qu'une sauvegarde ne pardonne pas.
    schedule_day     TINYINT     NOT NULL DEFAULT 1,
    keep_last        SMALLINT    NOT NULL DEFAULT 7,
    -- Quand l'ordonnanceur doit repasser. NULL = jamais (manuel, ou désactivé),
    -- ce qui sort la ligne de l'index des travaux dus **sans** condition
    -- supplémentaire dans la requête chaude.
    next_run_at      BIGINT      NULL,
    -- { name } chiffré.
    content          TEXT        NOT NULL,
    created          BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_backup_jobs_workspace (workspace_id),
    KEY idx_backup_jobs_due (next_run_at),
    KEY idx_backup_jobs_destination (destination_id),
    CONSTRAINT fk_bkp_job_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_bkp_job_destination FOREIGN KEY (destination_id) REFERENCES backup_destinations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Ce qu'un travail a produit, une fois. Jamais réécrit après sa clôture.
CREATE TABLE IF NOT EXISTS backup_runs (
    id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_id               INT         NOT NULL,
    workspace_id         INT         NOT NULL,
    -- 'running' | 'success' | 'failed'
    status               VARCHAR(16) NOT NULL DEFAULT 'running',
    started_at           BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    finished_at          BIGINT      NULL,
    size_bytes           BIGINT      NOT NULL DEFAULT 0,
    -- SHA-256 du **clair**, en hexadécimal. C'est ce qui permet de vérifier une
    -- restauration sans faire confiance à la destination: on rouvre l'archive,
    -- on recalcule, on compare. Le condensé du chiffré ne dirait rien, deux
    -- scellements du même clair donnant deux fichiers différents.
    checksum             CHAR(64)    NULL,
    -- Recopié de la destination au moment du run, et non lu depuis elle:
    -- basculer le chiffrement d'une destination ne doit pas rendre illisibles
    -- les archives d'avant en changeant rétroactivement ce qu'on croit d'elles.
    encrypted            TINYINT     NOT NULL DEFAULT 0,
    -- NULL = l'ordonnanceur.
    triggered_by_user_id INT         NULL,
    -- La rétention a-t-elle effacé l'archive ? La ligne reste: « il y a eu une
    -- sauvegarde le 3 mars » est un fait, même quand le fichier est parti.
    pruned               TINYINT     NOT NULL DEFAULT 0,
    -- { artifact, error } chiffré.
    content              TEXT        NOT NULL,
    KEY idx_backup_runs_job (job_id, started_at),
    KEY idx_backup_runs_workspace (workspace_id, started_at),
    -- Ce que la rétention va chercher: les réussites encore présentes d'un
    -- travail, de la plus ancienne à la plus récente.
    KEY idx_backup_runs_keep (job_id, status, pruned, started_at),
    CONSTRAINT fk_bkp_run_job FOREIGN KEY (job_id) REFERENCES backup_jobs(id) ON DELETE CASCADE,
    CONSTRAINT fk_bkp_run_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_bkp_run_user FOREIGN KEY (triggered_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

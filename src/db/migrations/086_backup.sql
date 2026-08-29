-- Sauvegardes: destinations, travaux, historique des exécutions. L'objet
-- appartient à l'espace et vit à l'étage ouvert: l'ordonnanceur passe à 3 h du
-- matin, sans session ni mot de passe.
--
-- Trois tables pour trois durées de vie: une destination survit à ses travaux,
-- un travail à ses exécutions, une exécution est un fait daté jamais réécrit.
--
-- En clair: `kind`, `device_id`, `source_kind`, les drapeaux et le calendrier,
-- ce qu'il faut pour trouver les travaux dus sans déchiffrer. Tout le reste
-- part dans `content`: l'adresse d'un bucket dit où sont les copies de tout ce
-- que DevEye détient.
--
-- Les noms de contraintes sont uniques par schéma, d'où le préfixe `fk_bkp_`.
--
-- La clé étrangère vers `devices` est posée à part, après un alignement de
-- collation: `devices` (004) est créée sans clause et hérite du défaut de la
-- base (`utf8mb4_0900_ai_ci` sur un MySQL 8 récent), ce fichier déclare
-- `utf8mb4_general_ci`. InnoDB refuse une FK entre deux collations différentes
-- (errno 3780). On aligne `device_id` sur la collation réelle de `devices.id`,
-- lue dans `INFORMATION_SCHEMA`.

-- Où les archives atterrissent. Trois genres derrière une seule table: un
-- travail ne veut savoir qu'une chose de sa destination, sait-elle accepter
-- des octets.
CREATE TABLE IF NOT EXISTS backup_destinations (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT         NOT NULL,
    -- 'local' | 'device' | 's3'
    kind         VARCHAR(16) NOT NULL,
    -- 'device' uniquement: la machine dont l'agent écrit le fichier. NULL quand
    -- l'appareil est supprimé: la destination reste, inutilisable, et le dit.
    device_id    CHAR(36)    NULL,
    -- S3: adressage par chemin (`https://hôte/bucket/clé`) plutôt que par
    -- sous-domaine. Vrai pour Garage et MinIO, faux pour AWS. En clair parce que
    -- c'est un commutateur de code, pas une donnée.
    path_style   TINYINT     NOT NULL DEFAULT 1,
    -- Les archives sont-elles scellées avant d'être écrites ? Défaut à 1: les
    -- octets qui quittent le serveur doivent être illisibles en face.
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

-- Aligner `device_id` sur la collation réelle de `devices.id` (voir en tête).
-- Interpolée depuis `INFORMATION_SCHEMA`, jamais depuis une donnée reçue.
-- Idempotent : réappliquer la même collation est un no-op.
SET @dev_collation = (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'id');
SET @s = CONCAT('ALTER TABLE backup_destinations MODIFY COLUMN device_id CHAR(36) COLLATE ',
                COALESCE(@dev_collation, 'utf8mb4_general_ci'), ' NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La contrainte, une fois les collations d'accord. Gardée pour le rejeu : un
-- `ADD CONSTRAINT` non gardé échouerait sur un nom déjà pris.
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
    -- RESTRICT et non CASCADE: supprimer une destination encore visée
    -- effacerait silencieusement la configuration de quelqu'un. On refuse, et
    -- l'écran dit combien de travaux il faut trancher d'abord.
    destination_id   INT         NOT NULL,
    -- 'database' | 'deveye' | 'cloudsync'
    source_kind      VARCHAR(16) NOT NULL,
    -- La connexion supervisée ou le partage CloudSync visé. NULL pour 'deveye'.
    -- Sans clé étrangère: elle pointerait deux tables différentes selon
    -- `source_kind`. La source disparue est détectée à l'exécution, et
    -- l'historique déjà écrit survit.
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
    -- SHA-256 du clair, en hexadécimal: vérifier une restauration sans faire
    -- confiance à la destination. Le condensé du chiffré ne dirait rien, deux
    -- scellements du même clair donnant deux fichiers différents.
    checksum             CHAR(64)    NULL,
    -- Figé au moment du run: basculer le chiffrement ensuite ne doit pas
    -- changer rétroactivement ce qu'on croit des archives d'avant.
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

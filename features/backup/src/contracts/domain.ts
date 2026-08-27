import { z } from 'zod';

/**
 * Les sauvegardes de l'espace: **où** ça atterrit, **quoi** part, et **ce qui
 * s'est passé** au dernier passage.
 *
 * Trois entités, et la séparation est la raison d'être du module:
 *
 *  - une **destination** est un endroit qui accepte des octets (un dossier du
 *    serveur, un dossier d'une machine enrôlée, un bucket S3). Elle ne sait rien
 *    de ce qu'on y range;
 *  - un **travail** dit quoi sauvegarder, vers quelle destination, à quelle
 *    cadence, et combien de copies garder;
 *  - une **exécution** est ce qu'un travail a produit une fois: une archive, sa
 *    taille, son empreinte, et son sort.
 *
 * Croiser les deux premiers est tout l'intérêt: la même base part vers le
 * Raspberry **et** vers un S3 distant en déclarant deux travaux, sans rien
 * dupliquer de la configuration d'accès.
 *
 * ## Toujours à l'étage ouvert
 *
 * Comme Uptime, Déploiement et Bases de données: l'ordonnanceur tourne sans
 * session ni mot de passe, donc tout ce qu'il doit lire — y compris la clé
 * secrète S3 — vit sous la clé de l'espace à l'étage ouvert. Un travail qui ne
 * pourrait s'exécuter qu'avec un humain devant l'écran ne serait pas une
 * sauvegarde.
 *
 * ## Ce qui est chiffré dans l'archive, et avec quelle clé
 *
 * Le contenu d'une archive est scellé avec le **même format que les blobs
 * CloudSync** (`DEVB` v2, AES-256-GCM par blocs de 1 Mio), sous une clé
 * **dérivée de la clé serveur** (`CRYPT_KEY_A`/`CRYPT_KEY_B`) et non stockée
 * nulle part. C'est la seule construction qui évite le serpent qui se mord la
 * queue: une clé rangée en base serait à l'intérieur de la sauvegarde de cette
 * base, donc illisible précisément le jour où on en a besoin.
 *
 * ⚠️ Corollaire à ne jamais perdre de vue: **`CRYPT_KEY_A` et `CRYPT_KEY_B` sont
 * la sauvegarde**. Une archive chiffrée sans elles n'est qu'un fichier de bruit.
 */

export const BACKUP_DESTINATION_NAME_MAX = 120;
export const BACKUP_JOB_NAME_MAX = 120;
export const BACKUP_PATH_MAX = 512;
export const BACKUP_ENDPOINT_MAX = 255;
export const BACKUP_BUCKET_MAX = 128;
export const BACKUP_ACCESS_KEY_MAX = 255;
export const BACKUP_SECRET_MAX = 512;

/**
 * Où une archive atterrit.
 *
 *  - `local`  — un dossier du serveur DevEye, sous `BACKUP_STORAGE_DIR`. Le plus
 *    simple, et le moins protecteur: la copie meurt avec la machine qu'elle
 *    sauvegarde. Utile comme premier palier, jamais comme seul palier.
 *  - `device` — un dossier d'une machine enrôlée, écrit **par son agent**. C'est
 *    ce qui fait d'un Raspberry Pi une cible de sauvegarde sans rien y installer
 *    d'autre que l'agent qui y tourne déjà.
 *  - `s3`     — un service compatible S3: Garage, MinIO, Scaleway, Backblaze,
 *    AWS. Le seul des trois qui sorte les octets du réseau local.
 */
export const backupDestinationKindSchema = z.enum(['local', 'device', 's3']);
export type BackupDestinationKind = z.infer<typeof backupDestinationKindSchema>;

/** Ce que le dernier contrôle d'accessibilité a dit d'une destination. */
export const backupDestinationStatusSchema = z.enum(['unknown', 'ok', 'error']);
export type BackupDestinationStatus = z.infer<typeof backupDestinationStatusSchema>;

/**
 * Ce qu'un travail sauvegarde.
 *
 *  - `database`  — une base supervisée de la feature Bases de données, par un
 *    vidage logique (`mysqldump` / `pg_dump`) à travers le même accès que la
 *    supervision, tunnel SSH compris.
 *  - `deveye`    — la base MySQL de DevEye elle-même. **Couvre le Monitoring,
 *    l'index CloudSync, les notes, les mots de passe, tout**: ces données vivent
 *    en base, donc les sauvegarder séparément reviendrait à les copier deux
 *    fois. C'est la sauvegarde à avoir si on n'en a qu'une.
 *  - `cloudsync` — les **blobs** d'un partage CloudSync, qui sont la seule
 *    partie de DevEye à ne pas vivre en base. Rendus en clair dans une archive
 *    `tar`, arborescence d'origine reconstituée depuis l'index: une archive doit
 *    se restaurer sans DevEye, sinon ce n'est pas une sauvegarde.
 */
export const backupSourceKindSchema = z.enum(['database', 'deveye', 'cloudsync']);
export type BackupSourceKind = z.infer<typeof backupSourceKindSchema>;

/**
 * Quand un travail part.
 *
 * Volontairement **pas** un cron: cinq champs lisibles couvrent tout ce qu'on
 * demande à une sauvegarde, et une expression cron mal écrite est un travail qui
 * ne part jamais sans que rien ne le dise.
 */
export const backupScheduleKindSchema = z.enum(['manual', 'hourly', 'daily', 'weekly', 'monthly']);
export type BackupScheduleKind = z.infer<typeof backupScheduleKindSchema>;

/** Le sort d'une exécution. */
export const backupRunStatusSchema = z.enum(['running', 'success', 'failed']);
export type BackupRunStatus = z.infer<typeof backupRunStatusSchema>;

/** Une destination, telle que l'écran la montre. Le secret n'en sort jamais. */
export const backupDestinationSchema = z.object({
    id: z.number().int().positive(),
    kind: backupDestinationKindSchema,
    name: z.string().max(BACKUP_DESTINATION_NAME_MAX),
    /** `device` uniquement: la machine qui héberge le dossier. */
    deviceId: z.uuid().nullable(),
    /** Nom de l'appareil, joint pour l'affichage; `null` s'il a été supprimé. */
    deviceName: z.string().nullable(),
    /**
     * `local`/`device`: le dossier qui reçoit les archives.
     * `s3`: le préfixe dans le bucket (`''` = la racine).
     */
    path: z.string().max(BACKUP_PATH_MAX),
    /** `s3`: l'URL du service (`https://s3.exemple.fr`). */
    endpoint: z.string().max(BACKUP_ENDPOINT_MAX).nullable(),
    region: z.string().max(64).nullable(),
    bucket: z.string().max(BACKUP_BUCKET_MAX).nullable(),
    accessKeyId: z.string().max(BACKUP_ACCESS_KEY_MAX).nullable(),
    /** Le secret existe-t-il ? Sa valeur n'est jamais rendue. */
    hasSecret: z.boolean(),
    /**
     * Adressage par chemin (`https://hôte/bucket/clé`) plutôt que par
     * sous-domaine. Vrai pour Garage et MinIO, faux pour AWS — et c'est la
     * première chose qui casse quand on l'oublie.
     */
    pathStyle: z.boolean(),
    // Le chiffrement des archives n'est plus un attribut de la destination :
    // il se règle par TRAVAIL (`backupJobSchema.encryption`, migration 094).
    // Une destination dit où écrire, le travail dit sous quelle forme.
    status: backupDestinationStatusSchema,
    /** Message du dernier contrôle raté; `null` quand tout va bien. */
    lastError: z.string().nullable(),
    checkedAt: z.number().int().nullable(),
    /** Combien de travaux l'utilisent — ce qu'une suppression va couper. */
    jobCount: z.number().int().nonnegative(),
    created: z.number().int()
});
export type BackupDestination = z.infer<typeof backupDestinationSchema>;

/**
 * Sous quelle forme les archives d'un travail sont écrites.
 *
 * - `none` : en clair. Lisible par qui tient la destination ; à réserver aux
 *   destinations déjà sous la même garde que le serveur.
 * - `server` : scellées (AES-256-GCM) sous une clé dérivée de
 *   CRYPT_KEY_A / CRYPT_KEY_B — jamais stockée, donc jamais dans l'archive
 *   qu'elle protège, et récupérable par `scripts/restore-backup.mjs` avec ces
 *   deux seules variables.
 *
 * Il n'y a **pas** de mode « mot de passe » et ce n'est pas un oubli :
 * l'ordonnanceur tourne la nuit sans session, or la clé dérivée du mot de
 * passe ne vit que dans une session déverrouillée, en mémoire, à fenêtre
 * glissante (voir Docs/SECURITY_MODEL.md). Un tel mode ne pourrait ni tourner
 * planifié, ni survivre à un dump de plusieurs heures.
 */
export const backupEncryptionSchema = z.enum(['none', 'server']);
export type BackupEncryption = z.infer<typeof backupEncryptionSchema>;

/** Un travail: quoi, où, quand, et combien de copies on garde. */
export const backupJobSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(BACKUP_JOB_NAME_MAX),
    enabled: z.boolean(),
    /** La forme des archives à venir ; chaque exécution fige la sienne. */
    encryption: backupEncryptionSchema,
    destinationId: z.number().int().positive(),
    /** Recopié pour que la liste n'ait pas à recouper deux jeux de données. */
    destinationName: z.string(),
    destinationKind: backupDestinationKindSchema,
    source: backupSourceKindSchema,
    /** `database` → l'id de la connexion; `cloudsync` → l'id du partage; sinon `null`. */
    sourceId: z.number().int().positive().nullable(),
    /** Intitulé de la source, joint pour l'affichage; `null` si elle a disparu. */
    sourceName: z.string().nullable(),
    schedule: backupScheduleKindSchema,
    /** Heure locale du serveur (0-23), pour tout sauf `hourly` et `manual`. */
    scheduleHour: z.number().int().min(0).max(23),
    /** Jour de la semaine, 0 = dimanche. `weekly` uniquement. */
    scheduleWeekday: z.number().int().min(0).max(6),
    /** Quantième, borné à 28 pour exister tous les mois. `monthly` uniquement. */
    scheduleDay: z.number().int().min(1).max(28),
    /** Combien d'archives réussies on garde. Au-delà, la plus ancienne part. */
    keepLast: z.number().int().min(1).max(365),
    nextRunAt: z.number().int().nullable(),
    lastRunAt: z.number().int().nullable(),
    lastStatus: backupRunStatusSchema.nullable(),
    lastError: z.string().nullable(),
    /** Somme des tailles des archives encore présentes. */
    totalBytes: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    /**
     * Cet élément vient d'un **autre espace**, qui le projette ici.
     *
     * L'écran le signale d'une pastille : sans elle, rien ne distingue une
     * ligne locale d'une fenêtre sur l'espace voisin — et les gestes réservés
     * au domicile (supprimer, re-partager) sembleraient cassés au lieu de
     * s'expliquer.
     */
    foreign: z.boolean(),
    created: z.number().int()
});
export type BackupJob = z.infer<typeof backupJobSchema>;

/** Une exécution, et ce qu'elle a produit. */
export const backupRunSchema = z.object({
    id: z.number().int().positive(),
    jobId: z.number().int().positive(),
    status: backupRunStatusSchema,
    startedAt: z.number().int(),
    finishedAt: z.number().int().nullable(),
    /** Taille de l'archive écrite, en octets. `0` tant qu'elle n'est pas finie. */
    sizeBytes: z.number().int().nonnegative(),
    /** SHA-256 du **clair**, pour vérifier une restauration. `null` si échec. */
    checksum: z.string().nullable(),
    /** Chemin ou clé de l'objet écrit, tel qu'on le retrouve sur la destination. */
    artifact: z.string().nullable(),
    /** L'archive a-t-elle été scellée ? Recopié de la destination au moment du run. */
    encrypted: z.boolean(),
    /** `null` = déclenchée par l'ordonnanceur. */
    triggeredByUserId: z.number().int().positive().nullable(),
    error: z.string().nullable(),
    /** L'archive existe-t-elle encore, ou la rétention l'a-t-elle effacée ? */
    pruned: z.boolean()
});
export type BackupRun = z.infer<typeof backupRunSchema>;

/**
 * Une source proposée au choix, quand on crée un travail.
 *
 * Le client ne peut pas la construire seul: les bases vivent dans la feature
 * Bases de données, les partages dans CloudSync, et `deveye` n'existe nulle part
 * ailleurs qu'ici. Une commande dédiée évite trois appels croisés et trois
 * droits à vérifier côté écran.
 */
export const backupSourceCandidateSchema = z.object({
    kind: backupSourceKindSchema,
    /** `null` pour `deveye`, qui est unique par nature. */
    id: z.number().int().positive().nullable(),
    name: z.string(),
    /** Précision affichée en second ligne (moteur, hôte, chemin du partage). */
    detail: z.string().nullable(),
    /** Faux avec une raison quand la source existe mais n'est pas sauvegardable. */
    available: z.boolean(),
    reason: z.string().nullable()
});
export type BackupSourceCandidate = z.infer<typeof backupSourceCandidateSchema>;

/** Ce que rend un contrôle de destination. */
export const backupDestinationProbeSchema = z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    /** Espace occupé sous le préfixe/dossier, quand la destination sait le dire. */
    usedBytes: z.number().int().nonnegative().nullable(),
    /** Espace libre, quand la destination sait le dire (`local` et `device`). */
    freeBytes: z.number().int().nonnegative().nullable()
});
export type BackupDestinationProbe = z.infer<typeof backupDestinationProbeSchema>;

// ------------------------------------------------------------- lignes SQL

/** Ligne SQL (serveur uniquement). */
export interface BackupDestinationRow {
    id: number;
    workspace_id: number;
    /** 'local' | 'device' | 's3'. */
    kind: string;
    device_id: string | null;
    /** Adressage par chemin pour S3. */
    path_style: number;
    /** 'unknown' | 'ok' | 'error'. */
    status: string;
    checked_at: number | null;
    /**
     * { name, path, endpoint, region, bucket, accessKeyId, lastError } chiffré,
     * étage ouvert.
     *
     * Le nom d'un bucket et l'adresse d'un service disent où sont les
     * sauvegardes de quelqu'un: ce n'est pas une métadonnée de tri, ça n'a rien
     * à faire en clair. Ne restent dehors que `kind`, `device_id` et les
     * drapeaux — le strict nécessaire pour que l'ordonnanceur choisisse un
     * chemin de code sans déchiffrer.
     */
    content: string;
    /** Clé secrète S3, chiffrée à l'étage ouvert. Vide pour `local`/`device`. */
    secret_enc: string;
    created: number;
}

/** La même, augmentée de ce qu'une liste montre sans ouvrir la fiche. */
export interface BackupDestinationWithUsageRow extends BackupDestinationRow {
    job_count: number;
    /** `devices.name`, joint pour l'affichage. En clair en base. */
    device_name: string | null;
}

/** Ligne SQL (serveur uniquement). */
export interface BackupJobRow {
    id: number;
    workspace_id: number;
    destination_id: number;
    /** 'database' | 'deveye' | 'cloudsync'. */
    source_kind: string;
    source_id: number | null;
    enabled: number;
    /** 'manual' | 'hourly' | 'daily' | 'weekly' | 'monthly'. */
    schedule_kind: string;
    schedule_hour: number;
    schedule_weekday: number;
    schedule_day: number;
    keep_last: number;
    /** 'none' | 'server' : la forme des archives à venir. En clair, comme les
     *  colonnes d'ordonnancement : l'exécuteur choisit un chemin de code sans
     *  déchiffrer. */
    encryption: string;
    /**
     * Quand l'ordonnanceur doit repasser. `NULL` = jamais (travail manuel ou
     * désactivé), ce qui le sort de l'index des travaux dus **sans** condition
     * supplémentaire dans la requête chaude.
     */
    next_run_at: number | null;
    /** { name } chiffré, étage ouvert. */
    content: string;
    created: number;
}

/** La même, augmentée du résumé que la liste affiche. */
export interface BackupJobWithStateRow extends BackupJobRow {
    destination_kind: string;
    destination_content: string;
    last_run_at: number | null;
    last_status: string | null;
    /** Le `content` chiffré de la dernière exécution ({ artifact, error }). */
    last_run_content: string | null;
    total_bytes: number | string | null;
    run_count: number;
}

/** Ligne SQL (serveur uniquement). */
export interface BackupRunRow {
    id: number;
    job_id: number;
    workspace_id: number;
    /** 'running' | 'success' | 'failed'. */
    status: string;
    started_at: number;
    finished_at: number | null;
    size_bytes: number | string;
    checksum: string | null;
    encrypted: number;
    triggered_by_user_id: number | null;
    pruned: number;
    /** { artifact, error } chiffré, étage ouvert. */
    content: string;
}

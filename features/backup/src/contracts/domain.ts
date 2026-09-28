import { z } from 'zod';
import { pathExclusionSchema } from '@deveye/types';

/**
 * Sauvegardes : une destination (où), un travail (quoi, où, quand, combien de
 * copies) et une exécution (ce qu'un travail a produit une fois).
 *
 * Tout vit à l'étage ouvert : l'ordonnanceur tourne sans session ni mot de
 * passe, clé secrète S3 comprise. Les archives sont scellées au format DEVB
 * v2 sous une clé dérivée de CRYPT_KEY_A/CRYPT_KEY_B, jamais stockée : une clé
 * rangée en base serait à l'intérieur de la sauvegarde de cette base. Sans ces
 * deux variables, une archive chiffrée est irrécupérable.
 */

export const BACKUP_DESTINATION_NAME_MAX = 120;
export const BACKUP_JOB_NAME_MAX = 120;
export const BACKUP_PATH_MAX = 512;
export const BACKUP_ENDPOINT_MAX = 255;
export const BACKUP_BUCKET_MAX = 128;
export const BACKUP_ACCESS_KEY_MAX = 255;
export const BACKUP_HOST_MAX = 255;
export const BACKUP_USERNAME_MAX = 255;
/** Assez pour une clé SSH privée. */
export const BACKUP_SECRET_MAX = 8192;

/**
 * `local` : sur le serveur, dans le magasin d'objets de l'hôte (son disque
 * sous `BACKUP_STORAGE_DIR`, ou son bucket S3). `device` : un
 * dossier d'une machine enrôlée, écrit par son agent. `s3` : un service
 * compatible S3 (Garage, MinIO, Scaleway, Backblaze, AWS). `sftp` : un
 * serveur SSH (NAS, VPS). `webdav` : Nextcloud, Synology, kDrive.
 */
export const backupDestinationKindSchema = z.enum(['local', 'device', 's3', 'sftp', 'webdav']);
export type BackupDestinationKind = z.infer<typeof backupDestinationKindSchema>;

/** Comment une destination SFTP s'authentifie ; le secret est le mot de passe ou la clé privée. */
export const backupSftpAuthSchema = z.enum(['password', 'key']);
export type BackupSftpAuth = z.infer<typeof backupSftpAuthSchema>;

/** Ce que le dernier contrôle d'accessibilité a dit d'une destination. */
export const backupDestinationStatusSchema = z.enum(['unknown', 'ok', 'error']);
export type BackupDestinationStatus = z.infer<typeof backupDestinationStatusSchema>;

/**
 * `database` : vidage logique d'une base supervisée, par l'accès de la
 * supervision (tunnel compris). `deveye` : la base MySQL de DevEye, qui couvre
 * tout ce qui vit en base. `cloudsync` : les blobs d'un partage, en clair dans
 * un `tar` reconstitué depuis l'index, restaurable sans DevEye.
 * `deviceFolder` : un dossier d'une machine, archivé par son agent.
 */
export const backupSourceKindSchema = z.enum(['database', 'deveye', 'cloudsync', 'deviceFolder']);
export type BackupSourceKind = z.infer<typeof backupSourceKindSchema>;

/** Un chemin sur une machine : ce que l'agent accepte. */
export const BACKUP_FOLDER_PATH_MAX = 4096;
export const BACKUP_FOLDER_EXCLUSIONS_MAX = 100;

/** Le dossier qu'un travail `deviceFolder` archive, tel qu'on le règle. */
export const backupFolderSchema = z.object({
    deviceId: z.uuid(),
    /** Chemin absolu sur la machine. */
    path: z.string().min(1).max(BACKUP_FOLDER_PATH_MAX),
    exclusions: z.array(pathExclusionSchema).max(BACKUP_FOLDER_EXCLUSIONS_MAX),
    /** Ne pas descendre dans un autre système de fichiers (montage réseau, disque amovible). */
    oneFileSystem: z.boolean()
});
export type BackupFolder = z.infer<typeof backupFolderSchema>;

/** Pas de cron, volontairement : une expression mal écrite est un travail qui ne part jamais sans rien dire. */
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
     * `sftp`: le dossier sur le serveur, absolu ou relatif au dossier de connexion.
     * `webdav`: le dossier sous l'adresse (`''` = l'adresse elle-même).
     */
    path: z.string().max(BACKUP_PATH_MAX),
    /** `s3`: l'URL du service (`https://s3.exemple.fr`). `webdav`: l'URL de base du serveur. */
    endpoint: z.string().max(BACKUP_ENDPOINT_MAX).nullable(),
    region: z.string().max(64).nullable(),
    bucket: z.string().max(BACKUP_BUCKET_MAX).nullable(),
    accessKeyId: z.string().max(BACKUP_ACCESS_KEY_MAX).nullable(),
    /** `sftp`: l'hôte et son port. */
    host: z.string().max(BACKUP_HOST_MAX).nullable(),
    port: z.number().int().min(1).max(65535).nullable(),
    /** `sftp`/`webdav`: l'identifiant de connexion. */
    username: z.string().max(BACKUP_USERNAME_MAX).nullable(),
    sftpAuth: backupSftpAuthSchema.nullable(),
    /**
     * `sftp`: l'empreinte du serveur (`SHA256:…`), retenue au premier contrôle
     * réussi ; `null` tant qu'aucun contrôle ne l'a validée, et rien ne part
     * vers un serveur inconnu.
     */
    hostKey: z.string().nullable(),
    /** Le secret existe-t-il ? Sa valeur n'est jamais rendue. */
    hasSecret: z.boolean(),
    /** Adressage par chemin (`https://hôte/bucket/clé`) : vrai pour Garage et MinIO, faux pour AWS. */
    pathStyle: z.boolean(),
    status: backupDestinationStatusSchema,
    /** Message du dernier contrôle raté; `null` quand tout va bien. */
    lastError: z.string().nullable(),
    checkedAt: z.number().int().nullable(),
    /** Combien de travaux l'utilisent : ce qu'une suppression va couper. */
    jobCount: z.number().int().nonnegative(),
    created: z.number().int()
});
export type BackupDestination = z.infer<typeof backupDestinationSchema>;

/**
 * `none` : en clair. `server` : AES-256-GCM sous une clé dérivée de
 * CRYPT_KEY_A/CRYPT_KEY_B, jamais stockée, rouverte par
 * `scripts/restore-backup.mjs`. Pas de mode « mot de passe » : l'ordonnanceur
 * tourne sans session, or cette clé ne vit qu'en session déverrouillée.
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
    /**
     * `deviceFolder` : le dossier archivé, et le membre au nom de qui le travail
     * s'exécute. Ses droits sont revérifiés à chaque passage.
     */
    folder: backupFolderSchema
        .extend({
            deviceName: z.string().nullable(),
            authorUserId: z.number().int().positive(),
            authorName: z.string().nullable()
        })
        .nullable(),
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
    /** Vient d'un autre espace qui le projette ici ; l'écran le signale d'une pastille. */
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
    /** L'archive a-t-elle été scellée ? Figé au moment de l'exécution. */
    encrypted: z.boolean(),
    /** `null` = déclenchée par l'ordonnanceur. */
    triggeredByUserId: z.number().int().positive().nullable(),
    error: z.string().nullable(),
    /** Une archive réussie mais incomplète : éléments illisibles, fichiers modifiés pendant la lecture. */
    warning: z.string().nullable(),
    /** L'archive existe-t-elle encore, ou la rétention l'a-t-elle effacée ? */
    pruned: z.boolean()
});
export type BackupRun = z.infer<typeof backupRunSchema>;

/**
 * Une source proposée au choix d'un travail. Construite par le serveur : les
 * bases et les partages vivent dans d'autres features, derrière leurs droits.
 */
export const backupSourceCandidateSchema = z.object({
    kind: backupSourceKindSchema,
    /** `null` pour `deveye`, unique par nature, et pour `deviceFolder`, qui vise une machine. */
    id: z.number().int().positive().nullable(),
    /** `deviceFolder` : la machine dont on choisira ensuite le dossier. */
    deviceId: z.uuid().nullable(),
    name: z.string(),
    /** La phrase d'aide sous le champ, une fois la source choisie (moteur, hôte, contenu). */
    detail: z.string().nullable(),
    /** Le repère court à droite de l'option : le moteur, le nombre de fichiers. */
    tag: z.string().nullable(),
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

/** Ligne SQL (serveur uniquement). */
export interface BackupDestinationRow {
    id: number;
    workspace_id: number;
    /** 'local' | 'device' | 's3' | 'sftp' | 'webdav'. */
    kind: string;
    device_id: string | null;
    /** Adressage par chemin pour S3. */
    path_style: number;
    /** 'unknown' | 'ok' | 'error'. */
    status: string;
    checked_at: number | null;
    /**
     * `StoredDestination` chiffré à l'étage ouvert : un bucket et une adresse
     * disent où sont les sauvegardes de quelqu'un.
     */
    content: string;
    /**
     * Clé secrète S3, mot de passe (SFTP, WebDAV) ou clé privée SSH, chiffré à
     * l'étage ouvert. Vide pour `local`/`device`.
     */
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
    /** 'database' | 'deveye' | 'cloudsync' | 'deviceFolder'. */
    source_kind: string;
    source_id: number | null;
    enabled: number;
    /** 'manual' | 'hourly' | 'daily' | 'weekly' | 'monthly'. */
    schedule_kind: string;
    schedule_hour: number;
    schedule_weekday: number;
    schedule_day: number;
    keep_last: number;
    /** 'none' | 'server'. En clair : l'exécuteur choisit un chemin sans déchiffrer. */
    encryption: string;
    /** `NULL` = jamais (manuel ou désactivé), ce qui le sort de l'index des travaux dus. */
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

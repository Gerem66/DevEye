import { z } from 'zod';
import {
    BACKUP_ACCESS_KEY_MAX,
    BACKUP_BUCKET_MAX,
    BACKUP_DESTINATION_NAME_MAX,
    BACKUP_ENDPOINT_MAX,
    BACKUP_HOST_MAX,
    BACKUP_JOB_NAME_MAX,
    BACKUP_PATH_MAX,
    BACKUP_SECRET_MAX,
    BACKUP_USERNAME_MAX,
    backupDestinationKindSchema,
    backupDestinationProbeSchema,
    backupDestinationSchema,
    backupEncryptionSchema,
    backupFolderSchema,
    backupJobSchema,
    backupRunSchema,
    backupScheduleKindSchema,
    backupSftpAuthSchema,
    backupSourceCandidateSchema,
    backupSourceKindSchema,
    backupVolumeSchema
} from './domain';

/**
 * Commandes des sauvegardes : les destinations (où) et les travaux (quoi,
 * quand, combien de copies). Tout est à l'étage ouvert : aucune ne demande de
 * session déverrouillée.
 */

const destinationId = z.number().int().positive();
const jobId = z.number().int().positive();

/** Les destinations de l'espace, dans l'ordre où elles ont été déclarées. */
export const backupDestinationList = {
    command: 'backup.destinationList' as const,
    input: z.object({}),
    output: z.object({ destinations: z.array(backupDestinationSchema) })
};

/** Ce que tous les genres partagent ; les champs des autres genres valent `null`. */
const destinationFields = {
    name: z.string().min(1).max(BACKUP_DESTINATION_NAME_MAX),
    deviceId: z.uuid().nullable(),
    path: z.string().max(BACKUP_PATH_MAX),
    endpoint: z.string().max(BACKUP_ENDPOINT_MAX).nullable(),
    region: z.string().max(64).nullable(),
    bucket: z.string().max(BACKUP_BUCKET_MAX).nullable(),
    accessKeyId: z.string().max(BACKUP_ACCESS_KEY_MAX).nullable(),
    host: z.string().max(BACKUP_HOST_MAX).nullable(),
    port: z.number().int().min(1).max(65535).nullable(),
    username: z.string().max(BACKUP_USERNAME_MAX).nullable(),
    sftpAuth: backupSftpAuthSchema.nullable(),
    pathStyle: z.boolean()
};

/** Un seul schéma pour tous les genres : l'écran n'a qu'un formulaire. */
export const backupDestinationAdd = {
    command: 'backup.destinationAdd' as const,
    input: z.object({
        kind: backupDestinationKindSchema,
        ...destinationFields,
        secret: z.string().max(BACKUP_SECRET_MAX).nullable()
    }),
    output: z.object({ destination: backupDestinationSchema })
};

/**
 * `secret` omis = inchangé: le serveur ne l'a jamais rendu, on ne le réécrit
 * pas. `resetHostKey` oublie l'empreinte SFTP retenue, pour un serveur
 * réinstallé : le prochain contrôle retiendra la nouvelle.
 */
export const backupDestinationUpdate = {
    command: 'backup.destinationUpdate' as const,
    input: z.object({
        destinationId,
        ...destinationFields,
        secret: z.string().max(BACKUP_SECRET_MAX).optional(),
        resetHostKey: z.boolean().optional()
    }),
    output: z.object({ destination: backupDestinationSchema })
};

/** Refusée tant qu'un travail la vise : un travail sans destination n'a aucun comportement raisonnable. */
export const backupDestinationRemove = {
    command: 'backup.destinationRemove' as const,
    input: z.object({ destinationId }),
    output: z.object({ destinationId })
};

/** Écrit, relit puis efface un objet témoin : lister un bucket ne prouve pas qu'on peut y écrire. */
export const backupDestinationTest = {
    command: 'backup.destinationTest' as const,
    input: z.object({ destinationId }),
    output: backupDestinationProbeSchema
};

/** Les travaux de l'espace, avec l'état de leur dernier passage. */
export const backupJobList = {
    command: 'backup.jobList' as const,
    input: z.object({}),
    output: z.object({ jobs: z.array(backupJobSchema) })
};

/** Compte les travaux actifs. Métadonnée en clair pure, pour la tuile d'accueil. */
export const backupCount = {
    command: 'backup.count' as const,
    input: z.object({}),
    output: z.object({
        count: z.number().int().nonnegative(),
        /** Combien ont échoué à leur dernier passage. */
        failing: z.number().int().nonnegative()
    })
};

/** Un travail et son historique, du plus récent au plus ancien. */
export const backupJobGet = {
    command: 'backup.jobGet' as const,
    input: z.object({ jobId, limit: z.number().int().positive().max(100).optional() }),
    output: z.object({ job: backupJobSchema, runs: z.array(backupRunSchema) })
};

const jobBody = {
    name: z.string().min(1).max(BACKUP_JOB_NAME_MAX),
    destinationId,
    encryption: backupEncryptionSchema,
    source: backupSourceKindSchema,
    sourceId: z.number().int().positive().nullable(),
    /** `deviceFolder` seulement ; `null` pour les autres sources. */
    folder: backupFolderSchema.nullable(),
    /** `dockerVolume` seulement ; `null` pour les autres sources. */
    volume: backupVolumeSchema.nullable(),
    enabled: z.boolean(),
    schedule: backupScheduleKindSchema,
    scheduleHour: z.number().int().min(0).max(23),
    scheduleWeekday: z.number().int().min(0).max(6),
    scheduleDay: z.number().int().min(1).max(28),
    keepLast: z.number().int().min(1).max(365)
};

export const backupJobAdd = {
    command: 'backup.jobAdd' as const,
    input: z.object(jobBody),
    output: z.object({ job: backupJobSchema })
};

export const backupJobUpdate = {
    command: 'backup.jobUpdate' as const,
    input: z.object({ jobId, ...jobBody }),
    output: z.object({ job: backupJobSchema })
};

/**
 * Supprime un travail et son historique. Sur ce serveur, ses archives partent
 * avec lui : elles ne se compteraient plus, et resteraient sur le disque.
 * Ailleurs, elles restent où elles sont.
 */
export const backupJobRemove = {
    command: 'backup.jobRemove' as const,
    input: z.object({ jobId }),
    output: z.object({ jobId })
};

/**
 * Lance un travail tout de suite et rend l'exécution en `running` : une
 * sauvegarde dure des minutes, l'avancement se suit par le sujet `backup`.
 */
export const backupJobRun = {
    command: 'backup.jobRun' as const,
    input: z.object({ jobId }),
    output: z.object({ run: backupRunSchema })
};

/**
 * Les sources sauvegardables de l'espace, pour remplir le sélecteur. `kinds` :
 * les catégories offertes ici, dans l'ordre, chacune affichée même vide.
 */
export const backupSources = {
    command: 'backup.sources' as const,
    input: z.object({}),
    output: z.object({
        kinds: z.array(backupSourceKindSchema),
        candidates: z.array(backupSourceCandidateSchema)
    })
};

/** Efface l'archive d'une sauvegarde réussie, à sa destination : de quoi faire de la place. */
export const backupRunRemove = {
    command: 'backup.runRemove' as const,
    input: z.object({ runId: z.number().int().positive() }),
    output: z.object({ runId: z.number().int().positive() })
};

/** Les dernières exécutions de l'espace, tous travaux confondus. */
export const backupRuns = {
    command: 'backup.runs' as const,
    input: z.object({ limit: z.number().int().positive().max(200).optional() }),
    output: z.object({ runs: z.array(backupRunSchema) })
};

export const backupCommands = [
    backupDestinationList,
    backupDestinationAdd,
    backupDestinationUpdate,
    backupDestinationRemove,
    backupDestinationTest,
    backupJobList,
    backupCount,
    backupJobGet,
    backupJobAdd,
    backupJobUpdate,
    backupJobRemove,
    backupRunRemove,
    backupJobRun,
    backupSources,
    backupRuns
] as const;

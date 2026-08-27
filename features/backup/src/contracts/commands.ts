import { z } from 'zod';
import {
    BACKUP_ACCESS_KEY_MAX,
    BACKUP_BUCKET_MAX,
    BACKUP_DESTINATION_NAME_MAX,
    BACKUP_ENDPOINT_MAX,
    BACKUP_JOB_NAME_MAX,
    BACKUP_PATH_MAX,
    BACKUP_SECRET_MAX,
    backupDestinationKindSchema,
    backupDestinationProbeSchema,
    backupDestinationSchema,
    backupEncryptionSchema,
    backupJobSchema,
    backupRunSchema,
    backupScheduleKindSchema,
    backupSourceCandidateSchema,
    backupSourceKindSchema
} from './domain';

/**
 * Commandes des sauvegardes.
 *
 * Deux moitiés qui ne se recouvrent pas: les **destinations** (où) et les
 * **travaux** (quoi, quand, combien de copies). Tout est à l'étage ouvert, donc
 * aucune de ces commandes ne demande de session déverrouillée — c'est la
 * condition pour qu'une sauvegarde parte à 3 h du matin.
 *
 * `backup.deveyeDump` n'existe pas comme commande: la base de DevEye se
 * sauvegarde par un travail de source `deveye` comme les autres, et il n'y a
 * aucune raison de lui inventer un chemin à part.
 */

const destinationId = z.number().int().positive();
const jobId = z.number().int().positive();

// ---------------------------------------------------------- destinations

/** Les destinations de l'espace, dans l'ordre où elles ont été déclarées. */
export const backupDestinationList = {
    command: 'backup.destinationList' as const,
    input: z.object({}),
    output: z.object({ destinations: z.array(backupDestinationSchema) })
};

/**
 * Déclare une destination.
 *
 * Un seul schéma pour les trois genres, avec les champs des deux autres à
 * `null`: la forme alternative (trois commandes, ou une union discriminée)
 * obligerait l'écran à trois formulaires là où il n'en a qu'un, dont les champs
 * apparaissent selon le genre choisi.
 */
export const backupDestinationAdd = {
    command: 'backup.destinationAdd' as const,
    input: z.object({
        kind: backupDestinationKindSchema,
        name: z.string().min(1).max(BACKUP_DESTINATION_NAME_MAX),
        deviceId: z.uuid().nullable(),
        path: z.string().max(BACKUP_PATH_MAX),
        endpoint: z.string().max(BACKUP_ENDPOINT_MAX).nullable(),
        region: z.string().max(64).nullable(),
        bucket: z.string().max(BACKUP_BUCKET_MAX).nullable(),
        accessKeyId: z.string().max(BACKUP_ACCESS_KEY_MAX).nullable(),
        secret: z.string().max(BACKUP_SECRET_MAX).nullable(),
        pathStyle: z.boolean()
    }),
    output: z.object({ destination: backupDestinationSchema })
};

/** `secret` omis = inchangé: le serveur ne l'a jamais rendu, on ne le réécrit pas. */
export const backupDestinationUpdate = {
    command: 'backup.destinationUpdate' as const,
    input: z.object({
        destinationId,
        name: z.string().min(1).max(BACKUP_DESTINATION_NAME_MAX),
        deviceId: z.uuid().nullable(),
        path: z.string().max(BACKUP_PATH_MAX),
        endpoint: z.string().max(BACKUP_ENDPOINT_MAX).nullable(),
        region: z.string().max(64).nullable(),
        bucket: z.string().max(BACKUP_BUCKET_MAX).nullable(),
        accessKeyId: z.string().max(BACKUP_ACCESS_KEY_MAX).nullable(),
        secret: z.string().max(BACKUP_SECRET_MAX).optional(),
        pathStyle: z.boolean()
    }),
    output: z.object({ destination: backupDestinationSchema })
};

/**
 * Retire une destination. **Refusée** tant qu'un travail la vise.
 *
 * Contrairement aux jetons de déploiement, qui laissent la cible orpheline mais
 * vivante: un travail sans destination n'a aucun comportement raisonnable — il
 * ne peut ni s'exécuter ni le dire à l'avance. Mieux vaut obliger à trancher.
 */
export const backupDestinationRemove = {
    command: 'backup.destinationRemove' as const,
    input: z.object({ destinationId }),
    output: z.object({ destinationId })
};

/**
 * Contrôle qu'une destination est joignable et inscriptible, **maintenant**.
 *
 * Écrit puis relit puis efface un petit objet témoin: lister un bucket ne prouve
 * pas qu'on peut y écrire, et découvrir le contraire à 3 h du matin est
 * exactement ce que cette commande existe pour éviter.
 */
export const backupDestinationTest = {
    command: 'backup.destinationTest' as const,
    input: z.object({ destinationId }),
    output: backupDestinationProbeSchema
};

// ---------------------------------------------------------------- travaux

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
        /** Combien ont échoué à leur dernier passage — ce que la tuile signale. */
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
 * Supprime un travail et son historique.
 *
 * Les archives déjà écrites ne sont **pas** touchées: DevEye a produit des
 * fichiers chez quelqu'un d'autre, et les effacer parce qu'on range sa
 * configuration serait le contraire d'une sauvegarde. L'écran le dit.
 */
export const backupJobRemove = {
    command: 'backup.jobRemove' as const,
    input: z.object({ jobId }),
    output: z.object({ jobId })
};

/**
 * Lance un travail tout de suite.
 *
 * Ne rend pas l'archive: une sauvegarde dure des minutes, et attendre la réponse
 * d'une commande WS pendant ce temps-là ne marcherait pas. Elle inscrit
 * l'exécution en `running` et rend sa ligne; l'avancement se lit en
 * re-sollicitant, comme partout ailleurs (le sujet `backup` est diffusé à
 * chaque transition).
 */
export const backupJobRun = {
    command: 'backup.jobRun' as const,
    input: z.object({ jobId }),
    output: z.object({ run: backupRunSchema })
};

/** Les sources sauvegardables de l'espace, pour remplir le sélecteur. */
export const backupSources = {
    command: 'backup.sources' as const,
    input: z.object({}),
    output: z.object({ candidates: z.array(backupSourceCandidateSchema) })
};

/**
 * Les dernières exécutions de l'espace, tous travaux confondus.
 *
 * Ce que la vue d'ensemble montre: on veut savoir « est-ce que mes sauvegardes
 * tournent », pas ouvrir sept fiches pour le découvrir.
 */
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
    backupJobRun,
    backupSources,
    backupRuns
] as const;

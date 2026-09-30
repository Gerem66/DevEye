import { z } from 'zod';

/**
 * Les cibles de déploiement d'un espace, et l'historique de ce qu'on y a poussé.
 *
 * Une cible appartient à l'espace, pas à un projet : un projet n'en garde qu'une
 * liaison (`project_deploy_links`), et délier n'efface jamais la cible. Portée
 * étroite : déclencher et suivre, rien n'est configuré ici. Toujours à l'étage
 * ouvert, quel que soit le tier des projets rattachés : le suivi d'état tourne
 * sans session, et un projet confidentiel n'a donc pas de déploiement.
 */

export const DEPLOY_TITLE_MAX_LENGTH = 120;
export const DEPLOY_DESCRIPTION_MAX_LENGTH = 500;
export const DEPLOY_TARGET_NAME_MAX_LENGTH = 120;
/** `propriétaire/dépôt#workflow` va jusqu'à 151 caractères chez GitHub. */
export const DEPLOY_EXTERNAL_ID_MAX_LENGTH = 255;
/** Une branche Git : GitHub en accepte jusqu'à 255 caractères. */
export const DEPLOY_REF_MAX_LENGTH = 255;

/**
 * Les fournisseurs qu'un accès ouvre : une instance Dokploy (adresse et clé
 * d'API), ou GitHub (un jeton, sans adresse).
 */
export const deployCredentialProviderSchema = z.enum(['dokploy', 'github']);
export type DeployCredentialProvider = z.infer<typeof deployCredentialProviderSchema>;

/**
 * Le fournisseur d'une cible : celui de son accès, ou `agent` pour un service
 * docker compose d'une machine enrôlée, que son agent récupère et relance.
 */
export const deployProviderSchema = z.enum([...deployCredentialProviderSchema.options, 'agent']);
export type DeployProvider = z.infer<typeof deployProviderSchema>;

/**
 * L'état d'un déploiement, ramené à quatre valeurs : l'adaptateur y projette le
 * vocabulaire de chaque fournisseur.
 */
export const deployStatusSchema = z.enum(['queued', 'running', 'success', 'failed']);
export type DeployStatus = z.infer<typeof deployStatusSchema>;

/**
 * Ce que vise une cible chez son fournisseur, qui en décide la procédure :
 * application ou pile compose chez Dokploy (`application.deploy` /
 * `compose.deploy`), workflow chez GitHub, service compose d'une machine. Une
 * cible sans son type serait indéployable.
 */
export const deployTargetKindSchema = z.enum(['application', 'compose', 'workflow', 'service']);
export type DeployTargetKind = z.infer<typeof deployTargetKindSchema>;

/** Une cible de l'espace, et l'état de son dernier déclenchement. */
export const deployTargetSchema = z.object({
    id: z.number().int().positive(),
    provider: deployProviderSchema,
    kind: deployTargetKindSchema,
    /** Identifiant de la cible chez le fournisseur. En clair : il porte l'unicité. */
    externalId: z.string().max(DEPLOY_EXTERNAL_ID_MAX_LENGTH),
    name: z.string().max(DEPLOY_TARGET_NAME_MAX_LENGTH),
    /**
     * `null` = le jeton a été retiré (la cible reste, indéployable, et le dit),
     * ou la cible est portée par une machine.
     */
    credentialId: z.number().int().positive().nullable(),
    /** La machine d'une cible `agent` ; `null` ailleurs. */
    deviceId: z.string().nullable(),
    /**
     * Où elle vit, tel que son fournisseur le dit sans réseau : l'hôte d'une
     * instance Dokploy (deux instances peuvent servir la même pile sous le même
     * nom), `github.com/propriétaire/dépôt`.
     */
    location: z.string().nullable(),
    /** La branche sur laquelle un workflow se lance ; `null` ailleurs. */
    ref: z.string().nullable(),
    /** L'état du dernier déploiement, ou `null` si rien n'est jamais parti d'ici. */
    lastStatus: deployStatusSchema.nullable(),
    lastDeployAt: z.number().int().nullable(),
    /** Vient d'un autre espace qui le projette ici : l'écran le signale d'une pastille. */
    foreign: z.boolean(),
    /** Combien de projets la déploient. */
    projectCount: z.number().int().nonnegative(),
    /** L'offre de son propriétaire la tient en pause : ni suivi, ni déploiement, ni appel au fournisseur. */
    planPaused: z.boolean(),
    created: z.number().int()
});
export type DeployTarget = z.infer<typeof deployTargetSchema>;

/** Une cible proposée au choix, telle que le fournisseur la déclare. */
export const deployCandidateSchema = z.object({
    kind: deployTargetKindSchema,
    externalId: z.string(),
    name: z.string(),
    /** Chemin lisible chez le fournisseur (projet / environnement, dépôt), s'il en donne un. */
    path: z.string().nullable(),
    /** La branche par défaut d'un workflow, proposée à l'ajout. */
    ref: z.string().nullable()
});
export type DeployCandidate = z.infer<typeof deployCandidateSchema>;

/** Un déclenchement, et ce qu'il est devenu. */
export const deploymentSchema = z.object({
    id: z.number().int().positive(),
    targetId: z.number().int().positive(),
    /** Identifiant chez le fournisseur, quand il en donne un au déclenchement. */
    externalId: z.string().nullable(),
    status: deployStatusSchema,
    /** Qui l'a déclenché ; `null` = tâche de fond, ou compte supprimé depuis. */
    triggeredByUserId: z.number().int().positive().nullable(),
    title: z.string(),
    description: z.string(),
    url: z.string().nullable(),
    startedAt: z.number().int(),
    finishedAt: z.number().int().nullable()
});
export type Deployment = z.infer<typeof deploymentSchema>;

/**
 * Une ligne d'historique telle que le fournisseur la connaît, pas seulement
 * ce que DevEye a déclenché.
 *
 * `deploymentSchema` porte l'identité DevEye d'un déclenchement (`id`, `targetId`,
 * `triggeredByUserId`) ; celui-ci n'a que ce que le fournisseur rend, y compris
 * pour ce qui est parti de sa propre interface ou d'une CI. Aucun `id` DevEye n'existe
 * pour ces lignes-là, d'où un schéma distinct plutôt qu'un `Deployment` aux
 * champs devinés.
 */
export const deployHistoryEntrySchema = z.object({
    externalId: z.string().nullable(),
    status: deployStatusSchema,
    title: z.string(),
    description: z.string(),
    startedAt: z.number().int(),
    finishedAt: z.number().int().nullable()
});
export type DeployHistoryEntry = z.infer<typeof deployHistoryEntrySchema>;

/** Ligne SQL (serveur uniquement). */
export interface DeployTargetRow {
    id: number;
    workspace_id: number;
    credential_id: number | null;
    /** La machine d'une cible `agent`. */
    device_id: string | null;
    provider: string;
    /** 'application' | 'compose' | 'workflow' | 'service'. */
    target_kind: string;
    external_id: string;
    /** Rang dans la liste, entièrement défini par l'utilisateur (`deploy.reorder`). */
    sort_order: number;
    content: string;
    /**
     * Dernier rapprochement réussi ; `null` = jamais. Ordonne les cibles à
     * réinterroger, et distingue le premier rapprochement des suivants : c'est
     * ce qui empêche l'import initial de notifier tout l'historique.
     */
    synced_at: number | null;
    created: number;
}

/** Ligne SQL (serveur uniquement). */
export interface DeploymentRow {
    id: number;
    target_id: number;
    workspace_id: number;
    external_id: string | null;
    status: string;
    triggered_by_user_id: number | null;
    started_at: number;
    finished_at: number | null;
    /**
     * Un avis est-il déjà parti ? Il appartient au déploiement, pas au tour de
     * sondage : sans cette colonne, chaque tour renotifierait le même échec.
     */
    notified: number;
    content: string;
}

/**
 * Une cible à réinterroger. `base_url` vient du jeton par jointure (la boucle
 * de fond n'a pas de session). `in_flight` compte les déploiements non
 * terminés connus : une cible qui en a passe à chaque tour, les autres
 * attendent leur cadence.
 */
export interface DeployTargetSyncRow extends DeployTargetRow {
    base_url: string | null;
    in_flight: number;
}

/**
 * Une machine de l'espace, telle que le choix d'une cible la présente : un
 * agent trop ancien ne sait pas déployer, et la politique locale d'une machine
 * peut le refuser, ce que le serveur ne décide pas.
 */
export const deployMachineSchema = z.object({
    id: z.string(),
    name: z.string(),
    online: z.boolean(),
    /** Son agent connaît `composeDeploy`. */
    capable: z.boolean(),
    /** Sa politique locale accepte les déploiements (`allow_docker_deploy`). */
    allowed: z.boolean()
});
export type DeployMachine = z.infer<typeof deployMachineSchema>;

/**
 * Les accès de l'espace : l'adresse d'une instance Dokploy et sa clé d'API, ou
 * un jeton GitHub. Le secret ne sort jamais (`hasSecret` seulement). Chiffré à
 * l'étage ouvert : le suivi de fond tourne sans session.
 */
export const DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH = 64;
export const DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH = 512;

export const deployCredentialSchema = z.object({
    id: z.number().int().positive(),
    provider: deployCredentialProviderSchema,
    label: z.string().max(DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH),
    /** Racine de l'instance Dokploy, auto-hébergée par définition ; `null` pour GitHub. */
    baseUrl: z.string().nullable(),
    /**
     * L'appareil dont l'agent joint l'instance Dokploy, quand elle n'est pas
     * sur Internet (`baseUrl` est alors l'adresse vue par la machine) ; `null`
     * quand le serveur la joint lui-même.
     */
    deviceId: z.uuid().nullable(),
    hasSecret: z.boolean(),
    created: z.number().int(),
    /** Combien de cibles s'en servent : ce qu'une suppression va couper. */
    useCount: z.number().int().nonnegative()
});
export type DeployCredential = z.infer<typeof deployCredentialSchema>;

/** Ligne SQL (serveur uniquement). */
export interface DeployCredentialRow {
    id: number;
    workspace_id: number;
    provider: string;
    label: string;
    base_url: string | null;
    device_id: string | null;
    /** Le membre qui a choisi l'appareil : son droit sur la machine est revérifié à chaque usage. */
    author_user_id: number | null;
    secret_enc: string;
    created: number;
}

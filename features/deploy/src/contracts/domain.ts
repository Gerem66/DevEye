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
export const DEPLOY_EXTERNAL_ID_MAX_LENGTH = 128;

/** Les fournisseurs que le module sait déclencher (une énumération, pour le second). */
export const deployProviderSchema = z.enum(['dokploy']);
export type DeployProvider = z.infer<typeof deployProviderSchema>;

/**
 * L'état d'un déploiement, ramené à quatre valeurs : l'adaptateur y projette le
 * vocabulaire de chaque fournisseur.
 */
export const deployStatusSchema = z.enum(['queued', 'running', 'success', 'failed']);
export type DeployStatus = z.infer<typeof deployStatusSchema>;

/**
 * Application ou pile compose : chacune a sa procédure de déclenchement
 * (`application.deploy` / `compose.deploy`) et d'historique (`deployment.all` /
 * `deployment.allByCompose`). Une cible sans son type serait indéployable.
 */
export const deployTargetKindSchema = z.enum(['application', 'compose']);
export type DeployTargetKind = z.infer<typeof deployTargetKindSchema>;

/** Une cible de l'espace, et l'état de son dernier déclenchement. */
export const deployTargetSchema = z.object({
    id: z.number().int().positive(),
    provider: deployProviderSchema,
    kind: deployTargetKindSchema,
    /** Identifiant de la cible chez le fournisseur. En clair : il porte l'unicité. */
    externalId: z.string().max(DEPLOY_EXTERNAL_ID_MAX_LENGTH),
    name: z.string().max(DEPLOY_TARGET_NAME_MAX_LENGTH),
    /** `null` = le jeton a été retiré ; la cible reste, indéployable, et le dit. */
    credentialId: z.number().int().positive().nullable(),
    /**
     * L'adresse de l'instance, recopiée du jeton : deux instances peuvent servir
     * la même pile sous le même nom.
     */
    baseUrl: z.string().nullable(),
    /** L'état du dernier déploiement, ou `null` si rien n'est jamais parti d'ici. */
    lastStatus: deployStatusSchema.nullable(),
    lastDeployAt: z.number().int().nullable(),
    /** Vient d'un autre espace qui le projette ici : l'écran le signale d'une pastille. */
    foreign: z.boolean(),
    /** Combien de projets la déploient. */
    projectCount: z.number().int().nonnegative(),
    created: z.number().int()
});
export type DeployTarget = z.infer<typeof deployTargetSchema>;

/** Une cible proposée au choix, telle que le fournisseur la déclare. */
export const deployCandidateSchema = z.object({
    kind: deployTargetKindSchema,
    externalId: z.string(),
    name: z.string(),
    /** Chemin lisible chez le fournisseur (projet / environnement), s'il en donne un. */
    path: z.string().nullable()
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
 * Une ligne d'historique telle que le fournisseur la connaît — pas seulement
 * ce que DevEye a déclenché.
 *
 * `deploymentSchema` porte l'identité DevEye d'un déclenchement (`id`, `targetId`,
 * `triggeredByUserId`) ; celui-ci n'a que ce que Dokploy rend, y compris pour ce
 * qui est parti de sa propre interface ou d'une CI. Aucun `id` DevEye n'existe
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
    provider: string;
    /** 'application' | 'compose'. */
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
 * Les accès Dokploy de l'espace : l'adresse d'une instance et sa clé d'API.
 * Le secret ne sort jamais (`hasSecret` seulement). Chiffré à l'étage ouvert :
 * le suivi de fond tourne sans session.
 */
export const DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH = 64;
export const DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH = 512;

export const deployCredentialSchema = z.object({
    id: z.number().int().positive(),
    label: z.string().max(DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH),
    /** Racine de l'instance Dokploy, auto-hébergée par définition. */
    baseUrl: z.string().nullable(),
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
    label: string;
    base_url: string | null;
    secret_enc: string;
    created: number;
}

import { z } from 'zod';
import {
    DEPLOY_DESCRIPTION_MAX_LENGTH,
    DEPLOY_EXTERNAL_ID_MAX_LENGTH,
    DEPLOY_TARGET_NAME_MAX_LENGTH,
    DEPLOY_TITLE_MAX_LENGTH,
    deployCandidateSchema,
    deployHistoryEntrySchema,
    deployTargetKindSchema,
    deployTargetSchema,
    deploymentSchema,
    DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH,
    DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH,
    deployCredentialSchema
} from './domain';

/**
 * Commandes du déploiement. Une cible appartient à l'espace, un projet n'y
 * pointe (voir `projects.deployLink`). Tout est à l'étage ouvert : aucune de ces
 * commandes ne demande de session déverrouillée.
 */

const targetId = z.number().int().positive();
const credentialId = z.number().int().positive();

/** Les cibles de l'espace, dans l'ordre choisi par l'utilisateur. */
export const deployList = {
    command: 'deploy.list' as const,
    input: z.object({}),
    output: z.object({ targets: z.array(deployTargetSchema) })
};

/** Compte les cibles : métadonnée en clair, la tuile d'accueil l'affiche même session verrouillée. */
export const deployCount = {
    command: 'deploy.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/** Une cible et son historique de déclenchements, du plus récent au plus ancien. */
export const deployGet = {
    command: 'deploy.get' as const,
    input: z.object({ targetId, limit: z.number().int().positive().max(50).optional() }),
    output: z.object({
        target: deployTargetSchema,
        deployments: z.array(deploymentSchema),
        /** Les projets qui la déploient, pour que la fiche sache où elle sert. */
        projectIds: z.array(z.number().int().positive())
    })
};

/**
 * Déclare une cible. **Idempotente** sur (jeton, identifiant externe) : la même
 * application déclarée deux fois est la même cible, et la seconde déclaration
 * met simplement son intitulé à jour.
 */
export const deployAdd = {
    command: 'deploy.add' as const,
    input: z.object({
        credentialId,
        kind: deployTargetKindSchema,
        externalId: z.string().min(1).max(DEPLOY_EXTERNAL_ID_MAX_LENGTH),
        name: z.string().min(1).max(DEPLOY_TARGET_NAME_MAX_LENGTH)
    }),
    output: z.object({ target: deployTargetSchema })
};

/** Change le jeton, le type ou l'intitulé d'une cible. */
export const deployUpdate = {
    command: 'deploy.update' as const,
    input: z.object({
        targetId,
        credentialId: credentialId.nullable(),
        kind: deployTargetKindSchema,
        externalId: z.string().min(1).max(DEPLOY_EXTERNAL_ID_MAX_LENGTH),
        name: z.string().min(1).max(DEPLOY_TARGET_NAME_MAX_LENGTH)
    }),
    output: z.object({ target: deployTargetSchema })
};

/**
 * Supprime une cible et son historique. L'application chez le fournisseur n'est
 * pas touchée ; les projets qui la déployaient perdent leur liaison.
 */
export const deployRemove = {
    command: 'deploy.remove' as const,
    input: z.object({ targetId }),
    output: z.object({ targetId })
};

/** Range la liste : `targetIds` en est le contenu complet, dans son ordre final. */
export const deployReorder = {
    command: 'deploy.reorder' as const,
    input: z.object({ targetIds: z.array(targetId).min(1) }),
    output: z.object({ targetIds: z.array(targetId) })
};

/**
 * Les applications proposées par l'instance. Seule commande du module qui
 * appelle le fournisseur en direct : elle remplit un sélecteur.
 */
export const deployCandidates = {
    command: 'deploy.candidates' as const,
    input: z.object({ credentialId }),
    output: z.object({ candidates: z.array(deployCandidateSchema) })
};

/**
 * Déclenche un déploiement. Audité en `warn` : la seule action du module à
 * effet hors de DevEye. `projectId` ne sert qu'à la frise du projet d'où part le
 * geste ; depuis la feature, le déploiement n'appartient à aucun projet.
 */
export const deployTrigger = {
    command: 'deploy.trigger' as const,
    input: z.object({
        targetId,
        title: z.string().max(DEPLOY_TITLE_MAX_LENGTH),
        description: z.string().max(DEPLOY_DESCRIPTION_MAX_LENGTH),
        projectId: z.number().int().positive().optional()
    }),
    output: z.object({ deployment: deploymentSchema })
};

/**
 * L'historique complet d'une cible tel que Dokploy le rend, y compris ce qui
 * n'est pas parti de DevEye. Interroge l'instance à chaque appel : réservé à la
 * fiche d'une cible, jamais à une liste. `deployGet` reste le suivi local.
 */
export const deployHistory = {
    command: 'deploy.history' as const,
    input: z.object({ targetId }),
    output: z.object({ entries: z.array(deployHistoryEntrySchema) })
};

/**
 * Le journal complet d'un déploiement. `externalId` vient d'une ligne de
 * `deployHistory`. Repose sur un point d'entrée Dokploy sans procédure tRPC
 * (voir `dokploy.ts`) : peut échouer sur une instance qui l'authentifie autrement.
 */
export const deployLog = {
    command: 'deploy.log' as const,
    input: z.object({ targetId, externalId: z.string().min(1) }),
    output: z.object({ log: z.string() })
};

/** Les clés d'API Dokploy de l'espace. Le secret n'est jamais rendu. */
export const deployCredentialList = {
    command: 'deploy.credentialList' as const,
    input: z.object({}),
    output: z.object({ credentials: z.array(deployCredentialSchema) })
};

/**
 * L'origine d'une instance Dokploy : une URL http(s), sans chemin parasite. Le
 * serveur y appelle `/api/trpc/…` avec la clé d'API ; une chaîne libre laisserait
 * le membre choisir schéma, hôte et chemin de cet appel.
 */
const dokployBaseUrl = z.url({ protocol: /^https?$/ }).max(255);

/** Une instance Dokploy exige son adresse : sans elle, rien n'est adressable. */
export const deployCredentialAdd = {
    command: 'deploy.credentialAdd' as const,
    input: z.object({
        label: z.string().min(1).max(DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH),
        baseUrl: dokployBaseUrl,
        secret: z.string().min(1).max(DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH)
    }),
    output: z.object({ credential: deployCredentialSchema })
};

/** `secret` omis = inchangé : le serveur ne l'a jamais rendu, on ne le réécrit pas. */
export const deployCredentialUpdate = {
    command: 'deploy.credentialUpdate' as const,
    input: z.object({
        credentialId,
        label: z.string().min(1).max(DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH),
        baseUrl: dokployBaseUrl,
        secret: z.string().min(1).max(DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH).optional()
    }),
    output: z.object({ credential: deployCredentialSchema })
};

/**
 * Retire un jeton. Les cibles qui s'en servaient restent, sans jeton : elles
 * cessent d'être déployables et le disent.
 */
export const deployCredentialRemove = {
    command: 'deploy.credentialRemove' as const,
    input: z.object({ credentialId }),
    output: z.object({ credentialId })
};

export const deployCommands = [
    deployList,
    deployCount,
    deployGet,
    deployAdd,
    deployUpdate,
    deployRemove,
    deployReorder,
    deployCandidates,
    deployTrigger,
    deployHistory,
    deployLog,
    deployCredentialList,
    deployCredentialAdd,
    deployCredentialUpdate,
    deployCredentialRemove
] as const;

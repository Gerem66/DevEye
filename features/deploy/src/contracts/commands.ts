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
 * Commandes du déploiement.
 *
 * Feature d'espace de premier rang, sur le modèle de Git : une cible appartient
 * à l'espace, un projet n'y **pointe** (voir `project.deployLink`). Tout est à
 * l'étage ouvert, donc aucune de ces commandes ne demande de session
 * déverrouillée.
 *
 * Les clés d'API Dokploy vivent ici et non plus dans la feature Git, où elles
 * n'avaient atterri que faute de module pour les accueillir : poser la clé qui
 * déploie relève de `deploy`, pas de `git`.
 */

const targetId = z.number().int().positive();
const credentialId = z.number().int().positive();

/** Les cibles de l'espace, dans l'ordre choisi par l'utilisateur. */
export const deployList = {
    command: 'deploy.list' as const,
    input: z.object({}),
    output: z.object({ targets: z.array(deployTargetSchema) })
};

/**
 * Compte les cibles. Métadonnée en clair pure : la tuile d'accueil affiche
 * toujours un nombre, même session verrouillée.
 */
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
 * Supprime une cible, **et son historique avec elle**.
 *
 * L'application chez le fournisseur n'est pas touchée : DevEye ne fait que la
 * pointer. Les projets qui la déployaient perdent leur liaison, rien d'autre.
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
 * Les applications proposées par l'instance, pour en choisir une.
 *
 * Seule commande du module qui appelle un service externe en direct : elle sert
 * à remplir un sélecteur, et attendre le prochain tour d'un ordonnanceur pour
 * voir apparaître la liste n'aurait aucun sens.
 */
export const deployCandidates = {
    command: 'deploy.candidates' as const,
    input: z.object({ credentialId }),
    output: z.object({ candidates: z.array(deployCandidateSchema) })
};

/**
 * Déclenche un déploiement.
 *
 * Toujours audité en `warn` : c'est la seule action du module qui produise un
 * effet **hors** de DevEye, et savoir qui a poussé quoi en production compte
 * plus que le reste.
 *
 * `projectId` est facultatif et ne sert qu'à la frise du projet : déclenché
 * depuis l'onglet d'un projet, l'événement y est inscrit ; déclenché depuis la
 * feature, il n'appartient à aucun projet en particulier.
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
 * L'historique complet d'une cible, **tel que Dokploy le rend** — pas
 * seulement ce que DevEye a déclenché : un déploiement lancé depuis
 * l'interface de Dokploy ou une CI y apparaît aussi.
 *
 * Distincte de `deployGet`, qui reste le suivi local (léger, toujours
 * disponible sans réseau vers le fournisseur) : celle-ci interroge Dokploy en
 * direct à chaque appel, coûte une requête externe, et n'a donc de sens que
 * là où on la demande explicitement — la fiche d'une cible dans la feature,
 * pas l'onglet d'un projet qui en reliste plusieurs.
 */
export const deployHistory = {
    command: 'deploy.history' as const,
    input: z.object({ targetId }),
    output: z.object({ entries: z.array(deployHistoryEntrySchema) })
};

/**
 * Le journal complet d'un déploiement, tel que Dokploy l'a produit.
 *
 * `externalId` vient d'une ligne de `deployHistory` : c'est la seule façon dont
 * le client connaît un déploiement dont DevEye n'a pas forcément la ligne
 * locale. Repose sur un point d'entrée de Dokploy sans procédure tRPC dédiée
 * (voir l'adaptateur `dokploy.ts`) : peut échouer sur une instance qui
 * l'authentifie autrement, ou pas du tout — l'appelant le traite alors comme
 * n'importe quelle autre panne réseau.
 */
export const deployLog = {
    command: 'deploy.log' as const,
    input: z.object({ targetId, externalId: z.string().min(1) }),
    output: z.object({ log: z.string() })
};

// ------------------------------------------------------------------ jetons

/**
 * Les clés d'API Dokploy de l'espace.
 *
 * Quatre commandes jumelles de `git.credential*` : même table, même forme, mais
 * chaque feature n'expose que les jetons de ses fournisseurs et les garde
 * derrière son propre droit. Le secret n'est jamais rendu.
 */
export const deployCredentialList = {
    command: 'deploy.credentialList' as const,
    input: z.object({}),
    output: z.object({ credentials: z.array(deployCredentialSchema) })
};

/** Une instance Dokploy exige son adresse : sans elle, rien n'est adressable. */
export const deployCredentialAdd = {
    command: 'deploy.credentialAdd' as const,
    input: z.object({
        label: z.string().min(1).max(DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH),
        baseUrl: z.string().min(1).max(255),
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
        baseUrl: z.string().min(1).max(255),
        secret: z.string().min(1).max(DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH).optional()
    }),
    output: z.object({ credential: deployCredentialSchema })
};

/**
 * Retire un jeton. Les cibles qui s'en servaient **restent**, sans jeton
 * (`ON DELETE SET NULL`) : elles cessent d'être déployables et le disent, plutôt
 * que de disparaître avec leur clé.
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

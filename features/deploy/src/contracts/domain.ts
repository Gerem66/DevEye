import { z } from 'zod';

/**
 * Les cibles de déploiement d'un espace, et l'historique de ce qu'on y a poussé.
 *
 * **Une cible appartient à l'espace, pas à un projet.** C'est le renversement
 * qui fonde cette feature, le même que celui des dépôts git : une pile compose
 * sert souvent deux projets (un client, un serveur), et la modéliser comme une
 * propriété de l'un d'eux interdisait à l'autre de la voir. Un projet n'en garde
 * donc qu'une **liaison** (`project_deploy_links`), et délier n'efface jamais la
 * cible.
 *
 * Portée volontairement **étroite** : déclencher et suivre. DevEye ne configure
 * pas le déploiement, ne gère ni domaines ni variables d'environnement — tout
 * cela vit chez le fournisseur, qui le fait mieux. Ce module répond à deux
 * questions : « est-ce que je peux lancer ça d'ici ? » et « où en est le
 * dernier ? ».
 *
 * **Toujours à l'étage ouvert**, quel que soit le tier des projets qui s'y
 * rattachent : le suivi d'état tourne sans session, et une cible d'espace ne
 * peut pas suivre le palier de confidentialité de l'un de ses projets.
 * Corollaire assumé, identique à celui des dépôts : un projet confidentiel n'a
 * pas de déploiement.
 */

export const DEPLOY_TITLE_MAX_LENGTH = 120;
export const DEPLOY_DESCRIPTION_MAX_LENGTH = 500;
export const DEPLOY_TARGET_NAME_MAX_LENGTH = 120;
export const DEPLOY_EXTERNAL_ID_MAX_LENGTH = 128;

/**
 * Les fournisseurs que le module sait déclencher.
 *
 * Un seul pour l'instant, et l'énumération est là pour que le second n'ait pas à
 * réécrire le contrat. Distinct de `credentialProviderSchema`, qui couvre aussi
 * GitHub : un jeton GitHub ne déploie rien.
 */
export const deployProviderSchema = z.enum(['dokploy']);
export type DeployProvider = z.infer<typeof deployProviderSchema>;

/**
 * L'état d'un déploiement, ramené à quatre valeurs.
 *
 * Les fournisseurs ont chacun leur vocabulaire (`done`, `success`, `idle`,
 * `error`, `failed`…). L'adaptateur les projette là-dessus, pour que
 * l'interface n'ait qu'un seul jeu d'états à connaître.
 */
export const deployStatusSchema = z.enum(['queued', 'running', 'success', 'failed']);
export type DeployStatus = z.infer<typeof deployStatusSchema>;

/**
 * Ce qu'on déploie chez Dokploy : une **application** ou une pile **compose**.
 *
 * La distinction n'est pas cosmétique — chaque type a sa propre procédure de
 * déclenchement (`application.deploy` / `compose.deploy`) et sa propre
 * procédure d'historique (`deployment.all` / `deployment.allByCompose`). Une
 * cible sans son type serait indéployable.
 *
 * En pratique, une infra Dokploy est souvent majoritairement composée de piles
 * compose : les ignorer reviendrait à ne rien pouvoir déployer.
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
     * L'adresse de l'instance qui l'héberge, recopiée du jeton.
     *
     * Deux instances Dokploy peuvent servir la même pile sous le même nom ; sans
     * elle, deux lignes de la liste seraient indiscernables. Elle vient du jeton
     * et n'est jamais saisie ici.
     */
    baseUrl: z.string().nullable(),
    /** L'état du dernier déploiement, ou `null` si rien n'est jamais parti d'ici. */
    lastStatus: deployStatusSchema.nullable(),
    lastDeployAt: z.number().int().nullable(),
    /**
     * Cet élément vient d'un **autre espace**, qui le projette ici.
     *
     * L'écran le signale d'une pastille : sans elle, rien ne distingue une
     * ligne locale d'une fenêtre sur l'espace voisin — et les gestes réservés
     * au domicile (supprimer, re-partager) sembleraient cassés au lieu de
     * s'expliquer.
     */
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
     * Dernier rapprochement réussi avec le fournisseur ; `null` = jamais.
     *
     * Porte deux rôles à la fois, et c'est voulu : il ordonne les cibles à
     * réinterroger (la plus ancienne d'abord), **et** il distingue le premier
     * rapprochement des suivants. Cette seconde lecture est ce qui empêche
     * l'import initial de notifier : la première fois, tout l'historique de la
     * cible est « nouveau » sans que rien ne vienne de se produire.
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
     * Un avis est-il déjà parti pour ce déploiement ?
     *
     * Même rôle que `uptime_incidents.notified`, et pour la même raison : un avis
     * appartient au **déploiement**, pas au tour de sondage qui l'a vu. Sans
     * cette colonne, chaque tour renotifierait le même échec — et l'import
     * initial d'une cible en enverrait un par ligne d'historique.
     */
    notified: number;
    content: string;
}

/**
 * Une cible à réinterroger, avec l'adresse de son instance et de quoi choisir
 * son tour.
 *
 * `base_url` vient du jeton par jointure : la boucle de fond n'a pas de session
 * pour repasser par la feature, et faire un second aller-retour par cible pour
 * lire son jeton coûterait une requête de plus pour une donnée déjà jointe.
 *
 * `in_flight` compte les déploiements non terminés que DevEye connaît. Il ne
 * sert qu'à trier : une cible qui a quelque chose en vol passe à chaque tour,
 * les autres attendent leur cadence. C'est ce qui permet de suivre un
 * déploiement à la minute sans sonder toutes les cibles aussi souvent.
 */
export interface DeployTargetSyncRow extends DeployTargetRow {
    base_url: string | null;
    in_flight: number;
}

/**
 * Les accès Dokploy de l'espace : l'adresse d'une instance et sa clé d'API.
 *
 * Ils vivaient dans `workspace_credentials`, une table à deux propriétaires
 * (jetons GitHub de Git, clés Dokploy de Déploiement, distingués par un
 * `provider`). Le rapatriement du module les a ramenés chez lui, dans
 * `ft_deploy_credentials` (migration 099 du socle) : un module possède ses
 * tables, et une clé qui déploie n'a jamais eu de raison de partager la sienne
 * avec un jeton qui lit des dépôts. Le contrat perd donc son `provider`.
 *
 * Le secret ne sort **jamais** : seule sa présence est annoncée (`hasSecret`).
 * Toujours chiffré à l'étage ouvert : le suivi de fond tourne sans session.
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

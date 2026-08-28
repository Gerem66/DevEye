import { z } from 'zod';
import {
    AUDIENCE_BREAKDOWN_MAX,
    AUDIENCE_FUNNEL_MAX_STEPS,
    AUDIENCE_FUNNEL_NAME_MAX_LENGTH,
    AUDIENCE_MAX_ORIGINS,
    AUDIENCE_ORIGIN_MAX_LENGTH,
    AUDIENCE_RETENTION_MAX_DAYS,
    AUDIENCE_RETENTION_MIN_DAYS,
    AUDIENCE_SITE_DESCRIPTION_MAX_LENGTH,
    AUDIENCE_SITE_NAME_MAX_LENGTH,
    audienceActivitySchema,
    audienceBreakdownItemSchema,
    audienceDimensionSchema,
    audienceFunnelSchema,
    audienceFunnelStepDraftSchema,
    audienceLiveSchema,
    audienceOverviewSchema,
    audiencePlatformSchema,
    audienceRangeSchema,
    audienceVisitorModeSchema,
    audienceSiteSchema,
    audienceUsageSchema
} from './domain';

/**
 * Commandes de l'audience d'un espace.
 *
 * Préfixe unique `audience.`, comme `git.`, `database.` et `project.` — d'où le
 * camelCase derrière le point.
 *
 * ⚠️ Conséquence à connaître : le filet de démarrage (`MUTATION_VERB` dans
 * `src/features/_topics.ts`) cherche un verbe **juste après le point**. Il ne
 * verra donc **aucune** de ces commandes, et un `mutates` oublié ne produira
 * aucun avertissement. Il se relit à la main.
 *
 * ## Ce qui n'est pas ici
 *
 * L'**ingestion** n'est pas une commande. Elle entre par HTTP, sans session,
 * depuis des machines qui ne connaissent pas DevEye — voir `POST /api/t/b`. Ces
 * commandes-ci ne font que *lire* ce qu'elle a écrit, et *déclarer* les sites.
 *
 * L'espace visé n'apparaît dans aucune entrée : il voyage sur l'enveloppe WS et
 * le dispatcheur le résout, appartenance vérifiée, avant le handler.
 */

const siteId = z.number().int().positive();

/** Ce qu'on peut régler sur un site — identique à l'ajout et à la modification. */
const siteBody = {
    name: z.string().min(1).max(AUDIENCE_SITE_NAME_MAX_LENGTH),
    description: z.string().max(AUDIENCE_SITE_DESCRIPTION_MAX_LENGTH),
    platform: audiencePlatformSchema,
    visitorMode: audienceVisitorModeSchema,
    /**
     * Les hôtes autorisés à écrire. Le client envoie des hôtes nus
     * (`exemple.fr`) ou des origines complètes (`https://exemple.fr`) : le
     * serveur normalise, parce que c'est lui qui compare.
     */
    origins: z.array(z.string().max(AUDIENCE_ORIGIN_MAX_LENGTH)).max(AUDIENCE_MAX_ORIGINS),
    active: z.boolean(),
    retentionDays: z.number().int().min(AUDIENCE_RETENTION_MIN_DAYS).max(AUDIENCE_RETENTION_MAX_DAYS)
};

// ------------------------------------------------------------------ sites

/** Le nombre de sites de l'espace, pour la tuile de l'accueil. */
export const audienceCount = {
    command: 'audience.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/** Les sites de l'espace, dans l'ordre de l'utilisateur. */
export const audienceList = {
    command: 'audience.list' as const,
    input: z.object({}),
    output: z.object({ sites: z.array(audienceSiteSchema) })
};

/**
 * Un site, avec les projets qui le suivent et l'adresse de sa balise.
 *
 * `ingestOrigin` vient du serveur (`AUDIENCE_ORIGIN`, à défaut `PUBLIC_ORIGIN`)
 * et non de l'origine du navigateur : l'application est derrière le VPN, alors
 * que l'ingestion doit être joignable sans lui — les deux adresses diffèrent
 * donc par construction. La déduire côté client aurait donné une balise juste en
 * développement et fausse en production, ce qui est le pire des deux mondes.
 */
export const audienceGet = {
    command: 'audience.get' as const,
    input: z.object({ siteId }),
    output: z.object({
        site: audienceSiteSchema,
        usage: z.array(audienceUsageSchema),
        ingestOrigin: z.string()
    })
};

/**
 * Déclare un site. La clé publique est **engendrée par le serveur** : la laisser
 * choisir permettrait de viser celle d'un site existant d'un autre espace.
 */
export const audienceSiteAdd = {
    command: 'audience.siteAdd' as const,
    input: z.object(siteBody),
    output: z.object({ site: audienceSiteSchema })
};

export const audienceSiteUpdate = {
    command: 'audience.siteUpdate' as const,
    input: z.object({ siteId, ...siteBody }),
    output: z.object({ site: audienceSiteSchema })
};

/**
 * Supprime un site **et tout son historique**.
 *
 * Contrairement aux projets, rien ne s'archive ici : un site retiré n'a pas de
 * seconde vie, et garder des millions d'événements orphelins pour un objet que
 * plus rien ne nomme ne rendrait service à personne. Les liaisons de projet
 * tombent avec (`CASCADE`), les projets eux-mêmes ne bougent pas.
 */
export const audienceSiteRemove = {
    command: 'audience.siteRemove' as const,
    input: z.object({ siteId }),
    output: z.object({ ok: z.literal(true) })
};

/**
 * Renouvelle la clé publique.
 *
 * Le geste utile quand une clé s'est retrouvée là où elle n'aurait pas dû —
 * dépôt public, capture d'écran. L'ancienne cesse d'entrer **immédiatement** ;
 * l'historique déjà collecté, lui, reste : il a été mesuré, il est vrai.
 */
export const audienceSiteRotateKey = {
    command: 'audience.siteRotateKey' as const,
    input: z.object({ siteId }),
    output: z.object({ site: audienceSiteSchema })
};

export const audienceReorder = {
    command: 'audience.reorder' as const,
    input: z.object({ siteIds: z.array(siteId).min(1) }),
    output: z.object({ ok: z.literal(true) })
};

// ------------------------------------------------------------ statistiques

/** Le bandeau, la comparaison à la période précédente, et la courbe. */
export const audienceOverview = {
    command: 'audience.overview' as const,
    input: z.object({ siteId, range: audienceRangeSchema }),
    output: audienceOverviewSchema
};

/**
 * Un classement sur l'axe demandé.
 *
 * Une commande pour les neuf axes plutôt que neuf commandes : ils rendent tous
 * la même forme, se lisent par la même requête, et l'écran en affiche plusieurs
 * côte à côte. Neuf entrées auraient divergé au premier ajustement.
 */
export const audienceBreakdown = {
    command: 'audience.breakdown' as const,
    input: z.object({
        siteId,
        range: audienceRangeSchema,
        dimension: audienceDimensionSchema,
        limit: z.number().int().min(1).max(AUDIENCE_BREAKDOWN_MAX).optional()
    }),
    output: z.object({ items: z.array(audienceBreakdownItemSchema) })
};

/** La carte jour × heure, en heure **locale du visiteur**, et les fuseaux. */
export const audienceActivity = {
    command: 'audience.activity' as const,
    input: z.object({ siteId, range: audienceRangeSchema }),
    output: audienceActivitySchema
};

/**
 * Qui est là en ce moment (cinq dernières minutes).
 *
 * Volontairement séparée de `overview` : elle est minuscule, elle se relit
 * souvent, et la faire voyager avec le bandeau obligerait à recalculer tout
 * l'agrégat pour rafraîchir un compteur.
 */
export const audienceLive = {
    command: 'audience.live' as const,
    input: z.object({ siteId }),
    output: audienceLiveSchema
};

// ------------------------------------------------------------ entonnoirs

const funnelId = z.number().int().positive();

/** Les marches, dans l'ordre. Un entonnoir d'une seule marche n'en est pas un. */
const steps = z.array(audienceFunnelStepDraftSchema).min(2).max(AUDIENCE_FUNNEL_MAX_STEPS);

/**
 * Les entonnoirs d'un site, **avec leurs chiffres** sur la fenêtre demandée.
 *
 * Définitions et mesures dans la même réponse : l'écran n'affiche jamais l'une
 * sans l'autre, et les séparer aurait fait deux allers-retours pour dessiner un
 * seul graphique. Les entonnoirs se comptent en unités, pas en milliers.
 */
export const audienceFunnelList = {
    command: 'audience.funnelList' as const,
    input: z.object({ siteId, range: audienceRangeSchema }),
    output: z.object({ funnels: z.array(audienceFunnelSchema) })
};

/**
 * Définit un entonnoir à partir de ce que le site a **déjà** émis.
 *
 * C'est tout le découpage : le site pose des signaux nommés, l'entonnoir se
 * compose ici. Mesurer autre chose ne demande donc aucun redéploiement — ni
 * même de prévenir qui que ce soit.
 */
export const audienceFunnelAdd = {
    command: 'audience.funnelAdd' as const,
    input: z.object({
        siteId,
        name: z.string().min(1).max(AUDIENCE_FUNNEL_NAME_MAX_LENGTH),
        steps
    }),
    output: z.object({ funnelId })
};

export const audienceFunnelUpdate = {
    command: 'audience.funnelUpdate' as const,
    input: z.object({
        funnelId,
        name: z.string().min(1).max(AUDIENCE_FUNNEL_NAME_MAX_LENGTH),
        steps
    }),
    output: z.object({ ok: z.literal(true) })
};

/**
 * Supprime un entonnoir. **Aucune mesure n'est perdue** : un entonnoir n'est
 * qu'une lecture des événements déjà là, jamais une collecte à part. Le
 * recréer à l'identique rendrait exactement les mêmes chiffres.
 */
export const audienceFunnelRemove = {
    command: 'audience.funnelRemove' as const,
    input: z.object({ funnelId }),
    output: z.object({ ok: z.literal(true) })
};

export const audienceCommands = [
    audienceCount,
    audienceList,
    audienceGet,
    audienceSiteAdd,
    audienceSiteUpdate,
    audienceSiteRemove,
    audienceSiteRotateKey,
    audienceReorder,
    audienceOverview,
    audienceBreakdown,
    audienceActivity,
    audienceLive,
    audienceFunnelList,
    audienceFunnelAdd,
    audienceFunnelUpdate,
    audienceFunnelRemove
] as const;

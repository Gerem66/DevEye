import { createHash, randomBytes } from 'crypto';

import {
    audienceSiteSchema,
    type AudienceMetrics,
    type AudienceRange,
    type AudienceResolution,
    type AudienceSite,
    type AudienceSiteRow
} from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider, type ProjectUsage } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { normalizeHost } from './normalize';
import type { AudienceMetricsRow, AudienceRepo, AudienceSiteWithStatsRow } from './repo';
import type { AudienceIngest } from './service';

/**
 * Le socle de la feature Audience.
 *
 * **Un seul chiffre, toujours l'étage ouvert.** Un site appartient à l'espace et
 * peut servir plusieurs projets de paliers différents ; il ne peut donc suivre
 * aucun d'eux. Corollaire pratique, identique à celui des bases de données :
 * rien ici ne demande jamais de mot de passe, et l'ingestion publique lit ce
 * dont elle a besoin sans session — ce qui est exactement sa contrainte.
 * `ctx.cipher()` est cet étage (l'ex `ctx.secure.open`, que `audienceCipher`
 * enveloppait).
 */

/** Le contexte d'une commande d'Audience : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<AudienceRepo>;

/** Ce que porte `audience_sites.content`, chiffré. */
export interface StoredSite {
    name: string;
    description: string;
}

/**
 * L'ingestion du module, posée par `createService` au démarrage : le
 * remplaçant de `ctx.audience`, que le dispatcheur natif prêtait aux handlers.
 * Un singleton d'étendue module, assumé (patron `setEngine` de CloudSync,
 * `setSync` de Déploiement et Git) : l'ingestion est unique par processus,
 * exactement comme avant le rapatriement.
 */
let ingestRef: AudienceIngest | null = null;

export function setIngest(ingest: AudienceIngest | null): void {
    ingestRef = ingest;
}

/**
 * L'ingestion, si elle est montée.
 *
 * `null` hors service (tests, boot en cours), et chaque appelant dégrade comme
 * le faisait `ctx.audience?.` : une invalidation sans ingestion n'a rien à
 * vider. Elle sert à **une** chose : lui faire oublier ce qu'elle sait des
 * sites après une mutation (`invalidate`). Aucune lecture ne passe par elle :
 * les statistiques viennent du dépôt, pour qu'une réponse ne dépende jamais
 * de l'état d'une file en mémoire.
 */
export function ingestOf(): AudienceIngest | null {
    return ingestRef;
}

/**
 * L'identité d'un site dans l'espace.
 *
 * Le chiffrement étant non déterministe, `content` ne peut porter aucune
 * contrainte d'unicité : deux chiffrés de « Vitrine » diffèrent. Ce condensé la
 * porte à sa place — même motif que `slugRef` (git) et `nameRef` (bases).
 */
export function nameRef(name: string): string {
    return createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Engendre une clé publique.
 *
 * 144 bits tirés au sort, en base64url : imprévisible, sans caractère qui
 * demande un échappement dans un attribut HTML, et de longueur fixe — ce qui
 * permet à la colonne d'être un `CHAR(27)` et à l'index d'être compact.
 *
 * **Le serveur seul la choisit.** Laisser le client la proposer permettrait de
 * viser celle d'un site existant, y compris dans l'espace de quelqu'un d'autre.
 */
export function generatePublicKey(): string {
    return `pk_${randomBytes(18).toString('base64url')}`;
}

/**
 * Les origines telles qu'on les enregistre : un hôte par ligne, normalisé,
 * dédoublonné, et sans les vides.
 *
 * La normalisation est faite **à l'écriture** et non à la comparaison : c'est
 * une opération par réglage plutôt qu'une par visite, et l'utilisateur relit
 * ensuite exactement ce à quoi son origine sera confrontée.
 */
export function packOrigins(origins: string[]): string | null {
    const hosts = [...new Set(origins.map(normalizeHost).filter((h) => h.length > 0))];
    return hosts.length > 0 ? hosts.join('\n') : null;
}

/**
 * Les origines telles que la colonne les porte : une par ligne, normalisées.
 *
 * La seule lecture de la colonne, pour les écrans (`toSite`) comme pour
 * l'ingestion (le cache des sites) : le natif en avait deux copies identiques
 * (`unpackOrigins` côté feature, `parseOrigins` côté service), réunies au
 * rapatriement.
 */
export function parseOrigins(raw: string | null): string[] {
    if (!raw) return [];
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: SdkCipher, blob: string | null): Promise<T | null> {
    if (!blob) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return null;
    }
}

/**
 * Charge un site de l'espace actif, ou lève `not_found`.
 *
 * C'est **la** frontière d'espace de la feature : toute commande qui prend un
 * `siteId` commence par là, sans quoi elle répondrait sur le site d'autrui.
 */
export async function loadSite(ctx: Ctx, siteId: number, level: 'read' | 'write' = 'read'): Promise<AudienceSiteRow> {
    const row = await ctx.repo.findVisible(siteId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Site introuvable');
    // `ctx.items.assert` (l'ex `assertItem`) refuse en plus les sites qu'une
    // restriction de rôle masque ou passe en lecture seule.
    await ctx.items.assert(siteId, level);
    return row;
}

/**
 * Comme {@link loadSite}, mais exige que le site soit **chez l'appelant**.
 *
 * Pour les gestes réservés au domicile : ses réglages, sa clé publique, ses
 * entonnoirs, sa suppression. Une fenêtre lit les chiffres — c'est tout l'objet
 * de projeter un site vers l'espace d'une équipe.
 */
export async function loadHomeSite(ctx: Ctx, siteId: number): Promise<AudienceSiteRow> {
    const row = await loadSite(ctx, siteId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Ce site appartient à un autre espace : il se règle et se supprime depuis là-bas.'
        );
    }
    return row;
}

/**
 * Le codec du domicile d'un site visible — celui d'ici pour un site local.
 *
 * `ctx.sharing.scope()` est l'ex `shareScope(ctx, 'audience')` : `cipherFor`
 * ne rend un codec étranger que si la projection existe réellement.
 */
export async function siteCipher(ctx: Ctx, siteId: number): Promise<SdkCipher> {
    return (await ctx.sharing.scope()).cipherFor(siteId);
}

export async function toSite(
    cipher: SdkCipher,
    row: AudienceSiteWithStatsRow,
    foreign: boolean,
    /** Le nombre de projets qui le suivent, venu du contrat de Projets. */
    projectCount: number
): Promise<AudienceSite> {
    const body = await readJson<Partial<StoredSite>>(cipher, row.content);
    return audienceSiteSchema.parse({
        foreign,
        id: row.id,
        name: body?.name ?? '',
        description: body?.description ?? '',
        publicKey: row.public_key,
        platform: row.platform,
        visitorMode: row.visitor_mode,
        origins: parseOrigins(row.origins),
        active: Number(row.active) === 1,
        retentionDays: Number(row.retention_days),
        lastEventAt: row.last_event_at === null ? null : Number(row.last_event_at),
        views24h: row.views_24h,
        visitors24h: row.visitors_24h,
        projectCount,
        created: Number(row.created)
    });
}

/**
 * Un libellé rendu au client, ou une chaîne vide s'il est resté illisible.
 *
 * Tolérant exprès : un seul blob abîmé — une conversion de clé interrompue, par
 * exemple — ne doit pas faire échouer tout un classement. Une ligne sans
 * intitulé se voit et se signale ; un écran en erreur n'apprend rien.
 */
export async function readLabel(cipher: SdkCipher, blob: string): Promise<string> {
    return (await cipher.tryDecrypt(blob)) ?? '';
}

/** Une fenêtre de lecture : ses bornes, son pas, et le pas de la précédente. */
export interface RangeWindow {
    from: number;
    to: number;
    /** Largeur d'un seau, en secondes. */
    bucket: number;
    resolution: AudienceResolution;
}

const RANGE_SHAPE: Record<AudienceRange, { buckets: number; bucket: number; resolution: AudienceResolution }> = {
    '24h': { buckets: 24, bucket: 3600, resolution: 'hour' },
    '7d': { buckets: 7, bucket: 86400, resolution: 'day' },
    '30d': { buckets: 30, bucket: 86400, resolution: 'day' },
    '90d': { buckets: 90, bucket: 86400, resolution: 'day' },
    '365d': { buckets: 53, bucket: 7 * 86400, resolution: 'week' }
};

/**
 * Les bornes d'une fenêtre, alignées sur son propre pas.
 *
 * L'alignement compte : sans lui, « 7 jours » commencerait à l'heure exacte où
 * l'on a ouvert l'écran, et la première comme la dernière colonne seraient des
 * journées tronquées — dont on lirait la hauteur comme une baisse de trafic.
 * Chaque seau couvre donc une heure pleine, un jour plein ou une semaine
 * pleine, et le dernier est celui qui est en cours.
 */
export function rangeWindow(range: AudienceRange, now: number): RangeWindow {
    const shape = RANGE_SHAPE[range];
    // Les pas d'un jour et plus s'alignent sur la journée UTC ; l'heure sur
    // l'heure. `bucket` étant un diviseur du jour dans les deux cas, un seul
    // arrondi suffit.
    const step = shape.bucket >= 86400 ? 86400 : shape.bucket;
    const end = Math.floor(now / step) * step + step;
    return {
        from: end - shape.buckets * shape.bucket,
        to: end,
        bucket: shape.bucket,
        resolution: shape.resolution
    };
}

/** Ce que la ligne SQL des mesures devient une fois rapportée aux sessions. */
export function toMetrics(row: AudienceMetricsRow, returningVisitors = 0): AudienceMetrics {
    const sessions = row.sessions;
    return {
        views: row.views,
        visitors: row.visitors,
        // Jamais plus que le total : les deux nombres viennent de deux requêtes,
        // et une visite ouverte entre les deux ferait sinon dépasser le sous-
        // ensemble son ensemble, ce qui se lirait comme un bug d'affichage.
        returningVisitors: Math.min(returningVisitors, row.visitors),
        sessions,
        // Aucune session : zéro, et non une division par zéro déguisée en NaN
        // que le schéma zod rejetterait au retour.
        avgDurationSeconds: sessions > 0 ? row.duration / sessions : 0,
        bounceRate: sessions > 0 ? Math.min(1, row.bounces / sessions) : 0
    };
}

/**
 * Le contrat de Projets, relu à l'appel : offert par l'app tant que Projets
 * était native, par son module depuis ; d'ici, aucune différence. Absent (rien
 * n'offre la clé), la feature dégrade proprement : zéro projet partout, aucune
 * commande ne casse.
 */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/**
 * Combien de projets de l'espace **appelant** suivent chaque site.
 *
 * Le module ne lit aucune table de Projets : le compte vient de son contrat,
 * et les projets comptés sont ceux d'ICI, les mêmes que `audience.get` liste
 * (un site projeté montre les projets de la fenêtre, pas ceux de son
 * domicile).
 */
export async function projectCountsOf(ctx: Ctx): Promise<ReadonlyMap<number, number>> {
    return (await projectsProvider(ctx)?.countByItem('audience', ctx.workspaceId)) ?? new Map<number, number>();
}

/**
 * Les projets de l'espace appelant qui suivent ce site, avec leur titre :
 * c'est ce qui rend l'interconnexion cliquable dans les deux sens. Ils sont
 * tous à l'étage ouvert (le contrat le garantit), donc lisibles sans
 * session — un projet confidentiel ne peut pas lier.
 */
export async function projectUsageOf(ctx: Ctx, siteId: number): Promise<readonly ProjectUsage[]> {
    return (await projectsProvider(ctx)?.usageOf('audience', siteId, ctx.workspaceId)) ?? [];
}

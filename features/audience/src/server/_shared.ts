import { createHash, randomBytes } from 'crypto';

import {
    AUDIENCE_ORIGIN_ANY,
    audienceSiteSchema,
    type AudienceMetrics,
    type AudienceRange,
    type AudienceResolution,
    type AudienceSite,
    type AudienceSiteRow
} from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider, type ProjectUsage } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { normalizeHost, normalizePath } from './normalize';
import type { AudienceMetricsRow, AudienceRepo, AudienceSiteWithStatsRow } from './repo';
import type { AudienceIngest } from './service';

/**
 * Le socle de la feature Audience.
 *
 * Un seul chiffre, toujours l'étage ouvert : un site appartient à l'espace et
 * peut servir des projets de paliers différents. Rien ici ne demande donc de
 * mot de passe, et l'ingestion publique lit sans session.
 */

export type Ctx = SdkFeatureContext<AudienceRepo>;

/** Ce que porte `audience_sites.content`, chiffré. */
export interface StoredSite {
    name: string;
    description: string;
    /** Normalisés et dédoublonnés à l'écriture, voir `packTransitPaths`. */
    transitPaths: string[];
}

/** Singleton d'étendue module, posé par `createService` : une ingestion par processus. */
let ingestRef: AudienceIngest | null = null;

export function setIngest(ingest: AudienceIngest | null): void {
    ingestRef = ingest;
}

/**
 * L'ingestion, si elle est montée ; `null` hors service (tests, boot en cours)
 * et chaque appelant dégrade. Elle ne sert qu'à lui faire oublier les sites
 * après une mutation : aucune lecture ne passe par elle, pour qu'une réponse
 * ne dépende jamais d'une file en mémoire.
 */
export function ingestOf(): AudienceIngest | null {
    return ingestRef;
}

/**
 * L'identité d'un site dans l'espace : le chiffrement étant non déterministe,
 * `content` ne peut porter aucune contrainte d'unicité (deux chiffrés de
 * « Vitrine » diffèrent), ce condensé la porte à sa place.
 */
export function nameRef(name: string): string {
    return createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * 144 bits tirés au sort, en base64url : imprévisible, sans caractère à
 * échapper dans un attribut HTML, et de longueur fixe (colonne `CHAR(27)`).
 *
 * Le serveur seul la choisit : laisser le client la proposer permettrait de
 * viser la clé d'un site existant, y compris dans un autre espace.
 */
export function generatePublicKey(): string {
    return `pk_${randomBytes(18).toString('base64url')}`;
}

/**
 * Un hôte par ligne, normalisé et dédoublonné. La normalisation est faite à
 * l'écriture et non à la comparaison : une opération par réglage plutôt qu'une
 * par visite, et l'utilisateur relit ce à quoi son origine sera confrontée.
 *
 * `*` échappe à la normalisation et **absorbe la liste** : « tout le monde,
 * sauf ceux-ci » n'a aucun sens, et le laisser cohabiter avec des hôtes ferait
 * lire une restriction là où il n'y en a aucune.
 */
export function packOrigins(origins: string[]): string | null {
    if (origins.some((origin) => origin.trim() === AUDIENCE_ORIGIN_ANY)) return AUDIENCE_ORIGIN_ANY;
    const hosts = [...new Set(origins.map(normalizeHost).filter((h) => h.length > 0))];
    return hosts.length > 0 ? hosts.join('\n') : null;
}

/**
 * Les pages de transit telles qu'on les range : normalisées comme un chemin
 * reçu, sinon `/loading/` saisi ici ne retrouverait jamais `/loading` mesuré.
 */
export function packTransitPaths(paths: readonly string[]): string[] {
    return [...new Set(paths.filter((p) => p.trim().length > 0).map(normalizePath))];
}

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
 * Charge un site de l'espace actif, ou lève `not_found`. Frontière d'espace de
 * la feature : toute commande qui prend un `siteId` commence par là, sans quoi
 * elle répondrait sur le site d'autrui.
 */
export async function loadSite(ctx: Ctx, siteId: number, level: 'read' | 'write' = 'read'): Promise<AudienceSiteRow> {
    const row = await ctx.repo.findVisible(siteId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Site introuvable');
    // Refuse en plus les sites qu'une restriction de rôle masque ou passe en lecture seule.
    await ctx.items.assert(String(siteId), level);
    return row;
}

/**
 * Comme {@link loadSite}, mais exige que le site soit chez l'appelant : gestes
 * réservés au domicile (réglages, clé publique, entonnoirs, suppression). Une
 * fenêtre projetée ne fait que lire les chiffres.
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

/** Le codec du domicile d'un site visible, celui d'ici pour un site local. */
export async function siteCipher(ctx: Ctx, siteId: number): Promise<SdkCipher> {
    return (await ctx.sharing.scope()).cipherFor(String(siteId));
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
        transitPaths: body?.transitPaths ?? [],
        publicKey: row.public_key,
        platform: row.platform,
        visitorMode: row.visitor_mode,
        origins: parseOrigins(row.origins),
        active: Number(row.active) === 1,
        retentionDays: Number(row.retention_days),
        formsAuto: Number(row.forms_auto) === 1,
        submissionIpQuota: Number(row.submission_ip_quota),
        formHourlyQuota: Number(row.form_hourly_quota),
        eventIpQuota: Number(row.event_ip_quota),
        lastEventAt: row.last_event_at === null ? null : Number(row.last_event_at),
        views24h: row.views_24h,
        visitors24h: row.visitors_24h,
        projectCount,
        created: Number(row.created)
    });
}

/**
 * Un libellé, ou une chaîne vide s'il est resté illisible : tolérant exprès,
 * un seul blob abîmé ne doit pas faire échouer tout un classement.
 */
export async function readLabel(cipher: SdkCipher, blob: string): Promise<string> {
    return (await cipher.tryDecrypt(blob)) ?? '';
}

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
 * Les bornes d'une fenêtre, alignées sur son propre pas. Sans alignement, la
 * première et la dernière colonne seraient des journées tronquées, dont on
 * lirait la hauteur comme une baisse de trafic.
 */
export function rangeWindow(range: AudienceRange, now: number): RangeWindow {
    const shape = RANGE_SHAPE[range];
    // Les pas d'un jour et plus s'alignent sur la journée UTC, l'heure sur l'heure ;
    // `bucket` étant un diviseur du jour dans les deux cas, un seul arrondi suffit.
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
        // Jamais plus que le total : les deux nombres viennent de deux requêtes, et une
        // visite ouverte entre les deux ferait dépasser le sous-ensemble son ensemble.
        returningVisitors: Math.min(returningVisitors, row.visitors),
        sessions,
        // Aucune session : zéro, et non un NaN que le schéma zod rejetterait au retour.
        avgDurationSeconds: sessions > 0 ? row.duration / sessions : 0,
        bounceRate: sessions > 0 ? Math.min(1, row.bounces / sessions) : 0
    };
}

/**
 * Le contrat de Projets, relu à l'appel. Absent (rien n'offre la clé), la
 * feature dégrade proprement : zéro projet partout, aucune commande ne casse.
 */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/**
 * Combien de projets de l'espace appelant suivent chaque site. Le module ne lit
 * aucune table de Projets, le compte vient de son contrat : un site projeté
 * montre les projets de la fenêtre, pas ceux de son domicile.
 */
export async function projectCountsOf(ctx: Ctx): Promise<ReadonlyMap<number, number>> {
    return (await projectsProvider(ctx)?.countByItem('audience', ctx.workspaceId)) ?? new Map<number, number>();
}

/**
 * Les projets de l'espace appelant qui suivent ce site, avec leur titre : de
 * quoi rendre l'interconnexion cliquable dans les deux sens. Tous à l'étage
 * ouvert, donc lisibles sans session.
 */
export async function projectUsageOf(ctx: Ctx, siteId: number): Promise<readonly ProjectUsage[]> {
    return (await projectsProvider(ctx)?.usageOf('audience', siteId, ctx.workspaceId)) ?? [];
}

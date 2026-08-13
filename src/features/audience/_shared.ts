import { createHash, randomBytes } from 'crypto';

import {
    audienceSiteSchema,
    type AudienceMetrics,
    type AudienceRange,
    type AudienceResolution,
    type AudienceSite,
    type AudienceSiteRow
} from 'deveye-types';

import type { AudienceMetricsRow, AudienceSiteWithStatsRow } from '@/db/repos/audience';
import type { Cipher } from '@/Services/SecureStore';
import { normalizeHost } from '@/Services/audience/normalize';
import { env } from '@/Utils/Env';
import { FeatureError, type FeatureContext } from '../_define';

/**
 * Le socle de la feature Audience.
 *
 * **Un seul chiffre, toujours l'étage ouvert.** Un site appartient à l'espace et
 * peut servir plusieurs projets de paliers différents ; il ne peut donc suivre
 * aucun d'eux. Corollaire pratique, identique à celui des bases de données :
 * rien ici ne demande jamais de mot de passe, et l'ingestion publique lit ce
 * dont elle a besoin sans session — ce qui est exactement sa contrainte.
 */
export const READ = { feature: 'audience' } as const;
export const WRITE = { feature: 'audience', level: 'write' } as const;

export function audienceCipher(ctx: FeatureContext): Cipher {
    return ctx.secure.open;
}

/** Ce que porte `audience_sites.content`, chiffré. */
export interface StoredSite {
    name: string;
    description: string;
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
 * L'adresse par laquelle un site suivi atteint l'ingestion.
 *
 * `AUDIENCE_ORIGIN` quand elle est réglée, `PUBLIC_ORIGIN` sinon. **Le serveur
 * est le seul à la connaître** : l'application vit derrière le VPN et
 * l'ingestion doit être joignable sans lui, donc les deux adresses diffèrent par
 * construction. La déduire de l'origine du navigateur — ce que faisait la
 * première version — donnait une balise juste en développement et fausse en
 * production, c'est-à-dire fausse là où elle compte.
 *
 * La barre finale est retirée : la balise la recolle, et deux barres dans une
 * URL servie à des tiers se remarquent.
 */
export function ingestOrigin(): string {
    return (env.AUDIENCE_ORIGIN || env.PUBLIC_ORIGIN).replace(/\/+$/, '');
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

export function unpackOrigins(raw: string | null): string[] {
    if (!raw) return [];
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: Cipher, blob: string | null): Promise<T | null> {
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
export async function loadSite(ctx: FeatureContext, siteId: number): Promise<AudienceSiteRow> {
    const row = await ctx.db.audience.find(siteId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Site introuvable');
    return row;
}

export async function toSite(cipher: Cipher, row: AudienceSiteWithStatsRow): Promise<AudienceSite> {
    const body = await readJson<Partial<StoredSite>>(cipher, row.content);
    return audienceSiteSchema.parse({
        id: row.id,
        name: body?.name ?? '',
        description: body?.description ?? '',
        publicKey: row.public_key,
        platform: row.platform,
        visitorMode: row.visitor_mode,
        origins: unpackOrigins(row.origins),
        active: Number(row.active) === 1,
        retentionDays: Number(row.retention_days),
        lastEventAt: row.last_event_at === null ? null : Number(row.last_event_at),
        views24h: row.views_24h,
        visitors24h: row.visitors_24h,
        projectCount: row.project_count,
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
export async function readLabel(cipher: Cipher, blob: string): Promise<string> {
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

import { Resolver } from 'dns/promises';

import {
    OSINT_PROBE_LABELS,
    OSINT_RAW_MAX_LENGTH,
    type OsintField,
    type OsintLink,
    type OsintProbeId,
    type OsintProbeResult,
    type OsintProvider,
    type OsintScore,
    type OsintTag,
    type OsintTarget,
    type OsintTargetKind,
    type OsintTone
} from '../../contracts/domain';

// Réexportés pour que chaque sonde n'ait qu'un seul import à écrire.
export type {
    OsintField,
    OsintLink,
    OsintProbeId,
    OsintProbeResult,
    OsintProvider,
    OsintScore,
    OsintTag,
    OsintTarget,
    OsintTargetKind,
    OsintTone
};

/**
 * Une sonde est un {@link OsintProbeAdapter} : elle dit à quelles natures de
 * cible elle s'applique et rend un {@link OsintProbeResult}. Elle ne connaît ni
 * la base, ni la socket, ni le client.
 */

export interface OsintProbeContext {
    target: OsintTarget;
    /**
     * La clé du fournisseur, déjà déchiffrée, ou `null`. Une sonde qui en exige
     * une rend alors `skipped`, jamais une erreur.
     */
    key: string | null;
}

export interface OsintProbeAdapter {
    id: OsintProbeId;
    appliesTo: readonly OsintTargetKind[];
    /** Fournisseur dont la clé débloque (ou enrichit) cette sonde. */
    provider?: OsintProvider;
    /** Sans clé, la sonde ne peut rien faire (par opposition à un simple enrichissement). */
    requiresKey?: true;
    /** Combien de temps un résultat reste servi depuis le cache. */
    ttlMs?: number;
    run(ctx: OsintProbeContext): Promise<OsintProbeDraft>;
}

/** Ce qu'une sonde rend vraiment : le reste (`probe`, `tookMs`) est rempli par le moteur. */
export interface OsintProbeDraft {
    status?: OsintProbeResult['status'];
    title?: string;
    summary?: string | null;
    fields?: OsintField[];
    tags?: OsintTag[];
    links?: OsintLink[];
    score?: OsintScore | null;
    raw?: string | null;
}

/* ------------------------------ Constructeurs ----------------------------- */

export function field(label: string, value: string, extra: Omit<OsintField, 'label' | 'value'> = {}): OsintField {
    return { label, value, ...extra };
}

export function tag(label: string, tone: OsintTone = 'neutral'): OsintTag {
    return { label, tone };
}

/** Coupe une réponse brute à la taille que le contrat autorise. */
export function clampRaw(raw: string): string {
    if (raw.length <= OSINT_RAW_MAX_LENGTH) return raw;
    return `${raw.slice(0, OSINT_RAW_MAX_LENGTH)}\n… (tronqué)`;
}

/** Rend un `skipped` explicite : ce qui manque, et où l'obtenir. */
export function skipped(message: string, links: OsintLink[] = []): OsintProbeDraft {
    return { status: 'skipped', summary: message, links };
}

/**
 * Le message d'une erreur, ramené à quelque chose de lisible.
 *
 * `AbortSignal.timeout` lève une `TimeoutError` dont le message par défaut ne
 * dit rien à qui lit la carte ; les erreurs DNS de Node sortent en codes secs
 * (`ENOTFOUND`). Les deux méritent une phrase.
 */
export function describeError(e: unknown): string {
    if (e instanceof Error) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'Délai dépassé';
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return 'Aucun enregistrement';
        if (code === 'ETIMEDOUT') return 'Délai dépassé';
        if (code === 'ECONNREFUSED') return 'Connexion refusée';
        return e.message;
    }
    return String(e);
}

/* --------------------------------- Cache ---------------------------------- */

/**
 * Cache TTL en mémoire des résultats de sonde : sans lui, relancer la même cible
 * re-sollicite les fournisseurs, et c'est comme ça qu'on se fait limiter par
 * crt.sh ou un serveur WHOIS. Les données sont publiques, la clé est la cible
 * seule ; la clé d'API en est exclue, elle authentifie l'appel sans changer la
 * réponse.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;
/** Plafond dur, pour qu'un processus de longue vie ne grandisse pas sans fin. */
const CACHE_MAX = 800;

interface CachedProbe {
    result: OsintProbeResult;
    expires: number;
}

const cache = new Map<string, CachedProbe>();

/**
 * La présence d'une clé entre dans l'identité d'un résultat : une sonde rend
 * autre chose selon qu'elle en a une, et sans cela poser sa clé ne changeait
 * rien avant l'expiration, sur une feature dont le TTL va jusqu'à 24 h. La clé
 * elle-même n'y est pas, seulement le fait qu'il y en ait une : un secret n'a
 * rien à faire dans une clé de cache.
 */
function cacheKey(probe: OsintProbeId, target: OsintTarget, keyed: boolean): string {
    return `${probe}|${target.kind}|${target.value}|${keyed ? 'k' : '-'}`;
}

export function readCache(probe: OsintProbeId, target: OsintTarget, keyed: boolean): OsintProbeResult | null {
    const key = cacheKey(probe, target, keyed);
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return hit.result;
}

export function writeCache(
    probe: OsintProbeId,
    target: OsintTarget,
    keyed: boolean,
    result: OsintProbeResult,
    ttlMs = DEFAULT_TTL_MS
): void {
    // Une erreur ou une clé manquante ne se met pas en cache : ce sont des états
    // transitoires (réseau coupé, clé qu'on vient de poser), et les figer 15
    // minutes rendrait « réessayer » et l'écran de réglages inopérants.
    if (result.status === 'error' || result.status === 'skipped') return;

    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cacheKey(probe, target, keyed), { result, expires: Date.now() + ttlMs });
}

/** Oublie tout ce qui est en cache pour cette cible, clé posée ou non. */
export function dropCache(target: OsintTarget): void {
    const fragment = `|${target.kind}|${target.value}|`;
    for (const key of [...cache.keys()]) {
        if (key.includes(fragment)) cache.delete(key);
    }
}

/* -------------------------------- Exécution ------------------------------- */

/**
 * Exécute une sonde et normalise tout ce qui en sort, y compris un jet : une
 * sonde qui échoue rend une carte en erreur, jamais une exception qui
 * emporterait les autres cartes.
 */
export async function runProbe(adapter: OsintProbeAdapter, ctx: OsintProbeContext): Promise<OsintProbeResult> {
    const started = Date.now();
    const label = OSINT_PROBE_LABELS[adapter.id];

    let draft: OsintProbeDraft;
    try {
        draft = await adapter.run(ctx);
    } catch (e) {
        return {
            probe: adapter.id,
            status: 'error',
            title: label,
            summary: describeError(e),
            fields: [],
            tags: [],
            links: [],
            score: null,
            raw: null,
            tookMs: Date.now() - started
        };
    }

    const fields = draft.fields ?? [];
    return {
        probe: adapter.id,
        // Une sonde qui n'a rien trouvé et ne le dit pas est `empty`, pas `ok` :
        // une carte vide sans explication ressemble à un bug.
        status: draft.status ?? (fields.length > 0 || draft.summary ? 'ok' : 'empty'),
        title: draft.title ?? label,
        summary: draft.summary ?? null,
        fields,
        tags: draft.tags ?? [],
        links: draft.links ?? [],
        score: draft.score ?? null,
        raw: draft.raw != null ? clampRaw(draft.raw) : null,
        tookMs: Date.now() - started
    };
}

/* -------------------------------- Utilitaires ----------------------------- */

/** Exécute `fn` sur chaque élément, `limit` en vol au plus. Préserve l'ordre. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return out;
}

/** Date ISO → « 12 mars 2019 (il y a 6 ans) ». */
export function formatDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    const human = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const days = Math.round((Date.now() - t) / 86_400_000);
    if (days > 0) return `${human} (il y a ${humanDuration(days)})`;
    if (days < 0) return `${human} (dans ${humanDuration(-days)})`;
    return `${human} (aujourd'hui)`;
}

export function humanDuration(days: number): string {
    if (days < 31) return `${days} j`;
    if (days < 365) return `${Math.round(days / 30)} mois`;
    const y = days / 365;
    return y < 2 ? '1 an' : `${Math.floor(y)} ans`;
}

/** Jours restants avant `iso`, négatif si la date est passée. */
export function daysUntil(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return Math.round((t - Date.now()) / 86_400_000);
}

/**
 * Un résolveur DNS qui n'emprunte PAS celui du système : une sonde doit
 * interroger la zone publique, pas le cache d'un réseau local qui pourrait
 * répondre autre chose. Deux essais de quatre secondes, sans quoi une zone
 * lente immobiliserait toute la fiche.
 */
export function publicResolver(): Resolver {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    r.setServers(['1.1.1.1', '8.8.8.8']);
    return r;
}

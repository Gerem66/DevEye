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
} from 'deveye-types';

// Réexportés pour que chaque sonde n'ait qu'un seul import à écrire : elles
// travaillent toutes avec ces types-là, et les faire venir de deux endroits
// n'apporterait rien.
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
 * Socle des sondes OSINT.
 *
 * Une sonde est un {@link OsintProbeAdapter} : elle dit à quelles natures de
 * cible elle s'applique, et rend un {@link OsintProbeResult}. Elle ne connaît ni
 * la base, ni la socket, ni le client — d'où le fait qu'en ajouter une ne coûte
 * qu'un fichier.
 */

export interface OsintProbeContext {
    target: OsintTarget;
    /**
     * La clé du fournisseur, déjà déchiffrée, ou `null` si elle n'est pas posée.
     * Une sonde qui en exige une rend alors `skipped` — jamais une erreur.
     */
    key: string | null;
}

export interface OsintProbeAdapter {
    id: OsintProbeId;
    appliesTo: readonly OsintTargetKind[];
    /** Fournisseur dont la clé débloque (ou enrichit) cette sonde. */
    provider?: OsintProvider;
    /** Sans clé, la sonde ne peut rien faire du tout — par opposition à un simple enrichissement. */
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

export function link(label: string, href: string): OsintLink {
    return { label, href };
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

export function empty(message: string): OsintProbeDraft {
    return { status: 'empty', summary: message };
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
 * Cache TTL en mémoire des résultats de sonde.
 *
 * Une reconnaissance est répétitive par nature : on relance la même cible après
 * avoir lu une carte, on rouvre l'écran, on revient sur une entrée d'historique.
 * Sans cache, chacun de ces gestes re-sollicite les fournisseurs — et c'est
 * comme ça qu'on se fait limiter par crt.sh ou par un serveur WHOIS.
 *
 * Les données mises en cache sont **publiques** (un enregistrement DNS, un
 * certificat) : rien d'utilisateur ne transite ici. La clé est donc la cible
 * seule, sans le moindre élément d'identité de l'appelant — deux membres du même
 * espace qui interrogent le même domaine partagent légitimement la réponse.
 *
 * La clé d'API est **délibérément exclue** de la clé de cache, pour la même
 * raison que côté météo : elle authentifie l'appel, elle ne change pas la
 * réponse, et elle n'a rien à faire dans un matériau de clé.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;
/** Plafond dur, pour qu'un processus de longue vie ne grandisse pas sans fin. */
const CACHE_MAX = 800;

interface CachedProbe {
    result: OsintProbeResult;
    expires: number;
}

const cache = new Map<string, CachedProbe>();

function cacheKey(probe: OsintProbeId, target: OsintTarget): string {
    return `${probe}|${target.kind}|${target.value}`;
}

export function readCache(probe: OsintProbeId, target: OsintTarget): OsintProbeResult | null {
    const key = cacheKey(probe, target);
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
    cache.set(cacheKey(probe, target), { result, expires: Date.now() + ttlMs });
}

/** Oublie tout ce qui est en cache pour cette cible — sert au « réessayer » forcé. */
export function dropCache(target: OsintTarget): void {
    const suffix = `|${target.kind}|${target.value}`;
    for (const key of [...cache.keys()]) {
        if (key.endsWith(suffix)) cache.delete(key);
    }
}

/* -------------------------------- Exécution ------------------------------- */

/**
 * Exécute une sonde et normalise tout ce qui peut en sortir — y compris un jet.
 *
 * Une sonde qui échoue rend une carte en erreur, jamais une exception qui
 * remonterait au dispatcheur : sur un écran de reconnaissance, « ce fournisseur
 * n'a pas répondu » est un résultat comme un autre, et il ne doit pas emporter
 * les cinq autres cartes avec lui.
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

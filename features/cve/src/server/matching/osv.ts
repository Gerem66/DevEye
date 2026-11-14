import crypto from 'node:crypto';

import type { Dependency } from '../inventory/lockfiles';

/**
 * Le client d'OSV.dev : la base de vulnérabilités qui agrège les avis de tous
 * les écosystèmes (GitHub Advisory, celle de `npm audit`, RustSec, PyPA, Go
 * vulndb…). Publique, sans clé, et interrogeable en lot, ce qui est la raison
 * de la préférer à une API par fournisseur.
 *
 * Deux appels, et pas un de plus par paquet : `querybatch` dit quelles
 * versions sont touchées, `vulns/<id>` décrit chaque avis une seule fois même
 * s'il touche vingt paquets. Les deux réponses passent par un cache commun à
 * tout le serveur : deux espaces qui dépendent du même paquet ne le demandent
 * qu'une fois.
 *
 * OSV qui refuse ou ne répond pas ne fait jamais échouer un passage, et
 * n'efface rien : le résultat dit « indisponible », l'appelant garde les
 * constats d'avant, et plus aucun appel ne part avant la fin de la pause.
 */

const API = 'https://api.osv.dev/v1';

/** Ce que la requête en lot accepte d'un coup, chez OSV. */
const BATCH = 100;

/** Au-delà, un avis n'est plus détaillé : il garde son identifiant pour titre. */
const MAX_DETAILS = 500;

/** Combien de temps une réponse reste bonne. Un avis change peu, la liste des versions touchées un peu plus. */
const QUERY_TTL_S = 6 * 3600;
const VULN_TTL_S = 24 * 3600;

/** La pause après un refus sans `Retry-After`, ou une panne réseau. */
const COOLDOWN_MS = 10 * 60_000;

export interface OsvSeverityRef {
    id: string;
    summary: string;
    /** LOW / MODERATE / HIGH / CRITICAL, quand l'avis le dit. */
    severity: string | null;
    /** Le vecteur CVSS 3, pour en tirer une gravité quand l'avis n'en écrit pas. */
    cvss: string | null;
    /** Les identifiants publics de l'avis, CVE en tête. */
    aliases: string[];
    /** Les versions qui corrigent, quand l'avis en nomme. */
    fixed: string[];
    /**
     * Un avis qui ne décrit pas une faille : RustSec range sous ce nom les
     * paquets « unmaintained » ou « unsound ». `null` pour une vulnérabilité.
     */
    informational: string | null;
}

/** Ce que le dépôt embarque de vulnérable, un avis par dépendance touchée. */
export interface OsvHit {
    dependency: Dependency;
    vuln: OsvSeverityRef;
}

export type OsvOutcome = { status: 'ok'; hits: OsvHit[] } | { status: 'unavailable'; reason: string };

interface BatchResponse {
    results?: { vulns?: { id: string }[] }[];
}

/** Un avis tel qu'OSV le rend, réduit à ce que le module lit : c'est aussi ce que le cache garde. */
export interface VulnResponse {
    id?: string;
    summary?: string;
    details?: string;
    aliases?: string[];
    database_specific?: { severity?: string };
    severity?: { type?: string; score?: string }[];
    affected?: {
        package?: { name?: string; ecosystem?: string };
        database_specific?: { severity?: string; informational?: string };
        severity?: { type?: string; score?: string }[];
        ranges?: { events?: { fixed?: string }[] }[];
    }[];
}

/**
 * Le cache commun : par paquet, la liste des avis qui le touchent ; par avis,
 * sa description. Rien d'un espace n'y entre : une clé de paquet est une
 * empreinte, un avis est public.
 */
export interface OsvCache {
    queries(keys: readonly string[], freshSince: number): Promise<Map<string, string[]>>;
    saveQueries(entries: readonly { key: string; vulnIds: string[] }[], at: number): Promise<void>;
    vulns(ids: readonly string[], freshSince: number): Promise<Map<string, VulnResponse>>;
    saveVulns(entries: readonly { id: string; body: VulnResponse }[], at: number): Promise<void>;
}

export type OsvFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** L'état du service, pour la page des services externes de l'administrateur. */
export const osvHealth = {
    /** Avant cette date (ms), plus aucun appel ne part. */
    blockedUntil: 0,
    lastOkAt: 0,
    lastFailure: null as { at: number; reason: string } | null
};

/** Une panne ou un refus du service, qui met tout le serveur en pause. */
class OsvUnavailable extends Error {}

function block(reason: string, retryAfter: string | null): never {
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : COOLDOWN_MS;
    osvHealth.blockedUntil = Date.now() + wait;
    osvHealth.lastFailure = { at: Date.now(), reason };
    throw new OsvUnavailable(reason);
}

async function call(fetchImpl: OsvFetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
        res = await fetchImpl(url, { ...init, signal });
    } catch (e) {
        if (signal.aborted) throw e;
        block('OSV ne répond pas.', null);
    }
    if (res.status === 429) block('OSV limite le nombre de requêtes.', res.headers.get('retry-after'));
    if (res.status >= 500) block(`OSV est en panne (${res.status}).`, res.headers.get('retry-after'));
    if (!res.ok) throw new Error(`OSV a répondu ${res.status}`);
    osvHealth.lastOkAt = Date.now();
    return res;
}

/** La clé d'un paquet dans le cache : son empreinte, rien de lisible. */
export function queryKey(d: Dependency): string {
    return crypto.createHash('sha256').update(`${d.ecosystem}|${d.name}|${d.version}`).digest('hex');
}

/**
 * Confronte les dépendances au catalogue. `fetchImpl` est injecté pour que les
 * tests n'aient pas besoin du réseau ; `cache` manque dans les tests qui n'en
 * parlent pas.
 */
export async function queryOsv(
    deps: readonly Dependency[],
    signal: AbortSignal,
    options: { fetchImpl?: OsvFetch; cache?: OsvCache | null } = {}
): Promise<OsvOutcome> {
    if (deps.length === 0) return { status: 'ok', hits: [] };
    const fetchImpl = options.fetchImpl ?? fetch;
    const cache = options.cache ?? null;
    if (Date.now() < osvHealth.blockedUntil) {
        return { status: 'unavailable', reason: osvHealth.lastFailure?.reason ?? 'OSV est en pause.' };
    }
    const now = Math.floor(Date.now() / 1000);

    try {
        const keys = deps.map(queryKey);
        const known = cache ? await cache.queries(keys, now - QUERY_TTL_S) : new Map<string, string[]>();
        const missing = deps.filter((_, i) => !known.has(keys[i]));
        for (let i = 0; i < missing.length; i += BATCH) {
            signal.throwIfAborted();
            const chunk = missing.slice(i, i + BATCH);
            const res = await call(
                fetchImpl,
                `${API}/querybatch`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        queries: chunk.map((d) => ({
                            package: { name: d.name, ecosystem: d.ecosystem },
                            version: d.version
                        }))
                    })
                },
                signal
            );
            const json = (await res.json()) as BatchResponse;
            const fresh = chunk.map((d, index) => ({
                key: queryKey(d),
                vulnIds: (json.results?.[index]?.vulns ?? []).map((v) => v.id)
            }));
            for (const entry of fresh) known.set(entry.key, entry.vulnIds);
            await cache?.saveQueries(fresh, now);
        }

        const byVuln = new Map<string, Dependency[]>();
        deps.forEach((d, i) => {
            for (const id of known.get(keys[i]) ?? []) byVuln.set(id, [...(byVuln.get(id) ?? []), d]);
        });

        const detailed = [...byVuln.keys()].slice(0, MAX_DETAILS);
        const bodies = cache ? await cache.vulns(detailed, now - VULN_TTL_S) : new Map<string, VulnResponse>();
        const toSave: { id: string; body: VulnResponse }[] = [];
        for (const id of detailed) {
            if (bodies.has(id)) continue;
            signal.throwIfAborted();
            const res = await call(fetchImpl, `${API}/vulns/${encodeURIComponent(id)}`, {}, signal);
            const body = trim((await res.json()) as VulnResponse);
            bodies.set(id, body);
            toSave.push({ id, body });
        }
        if (toSave.length > 0) await cache?.saveVulns(toSave, now);

        const hits: OsvHit[] = [];
        for (const [id, affected] of byVuln) {
            const vuln = toRef(id, bodies.get(id) ?? { id, summary: id }, affected);
            for (const dependency of affected) hits.push({ dependency, vuln });
        }
        return { status: 'ok', hits: dedupeAliases(hits) };
    } catch (e) {
        if (e instanceof OsvUnavailable) return { status: 'unavailable', reason: e.message };
        throw e;
    }
}

/** Ce que le cache garde d'un avis : ce que `toRef` lit, rien de plus. */
function trim(json: VulnResponse): VulnResponse {
    return {
        id: json.id,
        summary: json.summary ?? json.details?.split('\n')[0],
        aliases: json.aliases,
        database_specific: json.database_specific?.severity ? { severity: json.database_specific.severity } : undefined,
        severity: json.severity,
        affected: json.affected?.map((a) => ({
            package: a.package,
            database_specific: a.database_specific
                ? { severity: a.database_specific.severity, informational: a.database_specific.informational }
                : undefined,
            severity: a.severity,
            ranges: a.ranges?.map((r) => ({ events: r.events?.filter((e) => e.fixed) }))
        }))
    };
}

/**
 * Une même faille publiée sous deux identifiants (GHSA et PYSEC, GHSA et
 * RUSTSEC) ne fait qu'un constat par dépendance. L'avis GitHub passe devant :
 * c'est lui que `npm audit` et l'onglet Security citent.
 */
function dedupeAliases(hits: OsvHit[]): OsvHit[] {
    const ordered = [...hits].sort(
        (a, b) => Number(!a.vuln.id.startsWith('GHSA')) - Number(!b.vuln.id.startsWith('GHSA'))
    );
    const seen = new Map<string, Set<string>>();
    const out: OsvHit[] = [];
    for (const hit of ordered) {
        const dep = `${hit.dependency.ecosystem} ${hit.dependency.name} ${hit.dependency.version}`;
        const names = seen.get(dep) ?? new Set<string>();
        const all = [hit.vuln.id, ...hit.vuln.aliases];
        if (all.some((n) => names.has(n))) continue;
        for (const n of all) names.add(n);
        seen.set(dep, names);
        out.push(hit);
    }
    return out;
}

function toRef(id: string, json: VulnResponse, affected: readonly Dependency[]): OsvSeverityRef {
    const names = new Set(affected.map((d) => d.name));
    const entries = (json.affected ?? []).filter((a) => names.has(a.package?.name ?? ''));
    const fixed = new Set<string>();
    for (const entry of entries) {
        for (const range of entry.ranges ?? []) {
            for (const event of range.events ?? []) {
                if (event.fixed) fixed.add(event.fixed);
            }
        }
    }
    const vectors = [...(json.severity ?? []), ...entries.flatMap((e) => e.severity ?? [])];
    return {
        id,
        summary: json.summary ?? json.details?.split('\n')[0] ?? id,
        // La gravité au niveau de l'avis d'abord, celle du paquet touché
        // ensuite : les avis GitHub ne la portent souvent qu'au second endroit.
        severity:
            json.database_specific?.severity ??
            entries.find((e) => e.database_specific?.severity)?.database_specific?.severity ??
            null,
        cvss: vectors.find((v) => v.type === 'CVSS_V3' && v.score)?.score ?? null,
        aliases: json.aliases ?? [],
        fixed: [...fixed],
        informational: entries.find((e) => e.database_specific?.informational)?.database_specific?.informational ?? null
    };
}

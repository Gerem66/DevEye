import { CVE_VECTOR_MAX, type CveReference, type CveSeverity } from '../contracts/domain';
import type { CveUpsert } from './repo';

/**
 * L'adaptateur du NVD (NIST), seule source du catalogue.
 *
 * Un seul point d'entrée sert les trois besoins : `lastModStartDate` pour le
 * fil, `cveId` pour un identifiant, `keywordSearch` pour un éditeur, un produit
 * ou un mot clé.
 */

const ENDPOINT = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
/**
 * Genereux : une fenetre d'ingestion ramene un millier de CVE avec toutes leurs
 * references, et le NVD prend ses aises. Une recherche interactive n'attend
 * jamais aussi longtemps, elle ne demande qu'une page courte.
 */
const TIMEOUT_MS = 60_000;
const PAGE_SIZE = 2000;

/**
 * Le NVD tolère 5 requêtes par 30 s sans clé, 50 avec, et recommande d'espacer.
 * L'écluse ci-dessous sérialise TOUT ce que le module envoie, ingestion et
 * recherches confondues : le quota est celui du serveur entier, pas d'un appel.
 */
const SPACING_KEYED_MS = 1_200;
const SPACING_FREE_MS = 6_500;
const RATE_LIMIT_BACKOFF_MS = 60_000;

let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
let blockedUntil = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sérialise et espace les appels. Un échec ne rompt jamais la file. */
function gated<T>(hasKey: boolean, run: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
        const spacing = hasKey ? SPACING_KEYED_MS : SPACING_FREE_MS;
        const wait = Math.max(blockedUntil - Date.now(), lastCallAt + spacing - Date.now(), 0);
        if (wait > 0) await sleep(wait);
        lastCallAt = Date.now();
        return run();
    });
    queue = result.then(
        () => undefined,
        () => undefined
    );
    return result;
}

/** Le format de date du NVD : ISO sans fuseau, compris comme UTC. */
function nvdDate(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toISOString().slice(0, 23);
}

/**
 * Le NVD rend `2024-03-29T17:15:21.150`, sans fuseau. Sans le `Z`, la norme
 * ECMAScript lit cette forme en heure LOCALE : la date dériverait du décalage
 * du serveur.
 */
function parseNvdDate(raw: string | undefined): number {
    if (!raw) return 0;
    const stamp = Date.parse(/[Z+]|-\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`);
    return Number.isNaN(stamp) ? 0 : Math.floor(stamp / 1000);
}

interface NvdCvssData {
    baseScore?: number;
    baseSeverity?: string;
    vectorString?: string;
}

interface NvdMetric {
    type?: string;
    cvssData?: NvdCvssData;
    baseSeverity?: string;
}

interface NvdCve {
    id?: string;
    published?: string;
    lastModified?: string;
    descriptions?: { lang?: string; value?: string }[];
    metrics?: Record<string, NvdMetric[] | undefined>;
    weaknesses?: { description?: { lang?: string; value?: string }[] }[];
    references?: { url?: string; tags?: string[] }[];
}

interface NvdResponse {
    totalResults?: number;
    vulnerabilities?: { cve?: NvdCve }[];
}

/** Le CVSS retenu, du plus récent au plus ancien : une CVE n'en porte pas toujours. */
const METRIC_ORDER = ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV40', 'cvssMetricV2'] as const;

function severityOf(score: number | null, label: string | undefined): CveSeverity {
    const named = label?.toLowerCase();
    if (named === 'critical' || named === 'high' || named === 'medium' || named === 'low') return named;
    if (score === null) return 'none';
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
}

function pickMetric(cve: NvdCve): NvdMetric | null {
    for (const kind of METRIC_ORDER) {
        const list = cve.metrics?.[kind];
        if (!list || list.length === 0) continue;
        // Le NVD marque d'un `Primary` l'evaluation qui fait foi, les autres
        // venant d'editeurs tiers.
        return list.find((m) => m.type === 'Primary') ?? list[0];
    }
    return null;
}

function normalize(cve: NvdCve): CveUpsert | null {
    if (!cve.id) return null;
    const metric = pickMetric(cve);
    const rawScore = metric?.cvssData?.baseScore;
    const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : null;
    const vector = metric?.cvssData?.vectorString ?? null;
    const summary =
        cve.descriptions?.find((d) => d.lang === 'en')?.value ?? cve.descriptions?.[0]?.value ?? 'Sans description.';
    const cwe =
        cve.weaknesses
            ?.flatMap((w) => w.description ?? [])
            .map((d) => d.value)
            .find((v) => typeof v === 'string' && v.startsWith('CWE-')) ?? null;
    const references: CveReference[] = (cve.references ?? [])
        .filter((r): r is { url: string; tags?: string[] } => typeof r.url === 'string')
        .map((r) => ({ url: r.url, tags: (r.tags ?? []).slice(0, 8) }));

    return {
        id: cve.id.toUpperCase(),
        published: parseNvdDate(cve.published),
        lastModified: parseNvdDate(cve.lastModified),
        severity: severityOf(score, metric?.cvssData?.baseSeverity ?? metric?.baseSeverity),
        score,
        // Un vecteur plus long que ce que la colonne accepte se perd plutot que
        // de se tronquer : un vecteur amputé est un vecteur faux.
        vector: vector !== null && vector.length <= CVE_VECTOR_MAX ? vector : null,
        cwe,
        summary,
        references
    };
}

async function call(params: URLSearchParams, apiKey: string | null): Promise<NvdResponse> {
    const res = await gated(apiKey !== null, () =>
        fetch(`${ENDPOINT}?${params.toString()}`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                accept: 'application/json',
                'user-agent': 'DevEye-Dashboard',
                ...(apiKey ? { apiKey } : {})
            }
        })
    );
    if (res.status === 403 || res.status === 429) {
        blockedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        throw new Error('Quota du NVD atteint, réessayer plus tard.');
    }
    if (!res.ok) throw new Error(`NVD a répondu HTTP ${res.status}.`);
    return (await res.json()) as NvdResponse;
}

function entriesOf(body: NvdResponse): CveUpsert[] {
    return (body.vulnerabilities ?? [])
        .map((v) => (v.cve ? normalize(v.cve) : null))
        .filter((e): e is CveUpsert => e !== null);
}

export interface NvdClient {
    /** Les CVE modifiées entre deux instants (secondes epoch), paginées. */
    window(from: number, to: number, apiKey: string | null, maxPages: number): Promise<CveUpsert[]>;
    byId(cveId: string, apiKey: string | null): Promise<CveUpsert | null>;
    keyword(query: string, apiKey: string | null, limit: number): Promise<CveUpsert[]>;
}

export const nvdClient: NvdClient = {
    async window(from, to, apiKey, maxPages) {
        const all: CveUpsert[] = [];
        for (let page = 0; page < maxPages; page++) {
            const params = new URLSearchParams({
                lastModStartDate: nvdDate(from),
                lastModEndDate: nvdDate(to),
                resultsPerPage: String(PAGE_SIZE),
                startIndex: String(page * PAGE_SIZE),
                noRejected: ''
            });
            const body = await call(params, apiKey);
            const batch = entriesOf(body);
            all.push(...batch);
            if (batch.length < PAGE_SIZE || all.length >= (body.totalResults ?? all.length)) break;
        }
        return all;
    },
    async byId(cveId, apiKey) {
        const body = await call(new URLSearchParams({ cveId }), apiKey);
        return entriesOf(body)[0] ?? null;
    },
    async keyword(query, apiKey, limit) {
        const page = Math.min(limit, PAGE_SIZE);
        const params = (startIndex: number): URLSearchParams =>
            new URLSearchParams({
                keywordSearch: query,
                resultsPerPage: String(page),
                startIndex: String(startIndex),
                noRejected: ''
            });

        // Le NVD rend ses correspondances par identifiant CROISSANT, sans
        // paramètre de tri : la première page d'une recherche « log4j » est
        // celle de 2008, pas Log4Shell. La dernière page porte les plus
        // récentes, et le premier appel est ce qui dit où elle commence.
        const first = await call(params(0), apiKey);
        const total = first.totalResults ?? 0;
        if (total <= page) return entriesOf(first);
        return entriesOf(await call(params(total - page), apiKey));
    }
};

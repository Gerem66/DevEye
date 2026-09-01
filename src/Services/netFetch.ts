/**
 * Primitives d'accès au réseau public, partagées par tout ce qui va chercher
 * quelque chose dehors : un garde SSRF écrit deux fois est un garde qu'on
 * corrigera une fois.
 *
 * Le garde lui-même vit dans `@deveye/types/sdk/server`, d'où un module
 * externe peut l'atteindre : l'app ne l'importe pas deux fois.
 */
export { isPublicIp, isSafePublicUrl } from '@deveye/types/sdk/server';

export const FETCH_TIMEOUT_MS = 4500;

export const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Branded site icon for any host, via Google's favicon service (no fetch). */
export function faviconUrl(host: string): string {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

export function fmtCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
}

/** Compact relative age of an ISO date (e.g. "3j", "2 sem", "5 mo", "1 an"). */
export function relativeShort(iso: string): string | null {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const days = Math.floor((Date.now() - t) / 86_400_000);
    if (days <= 0) return 'auj.';
    if (days < 7) return `${days} j`;
    if (days < 31) return `${Math.floor(days / 7)} sem`;
    if (days < 365) return `${Math.floor(days / 30)} mo`;
    const y = Math.floor(days / 365);
    return `${y} an${y > 1 ? 's' : ''}`;
}

export function isValidHttpUrl(s: string): boolean {
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Cette adresse IP est-elle routable publiquement ? Couvre boucle locale,
 * RFC 1918, lien-local, CGNAT, en v4 comme en v6, y compris la forme
 * IPv4-mappée (`::ffff:10.0.0.1`) par laquelle un filtre naïf se contourne.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function decodeEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
        .trim();
}

/** Extract a `<meta property|name="prop" content="...">` value, if present. */
export function metaTag(html: string, prop: string): string | null {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    return content ? decodeEntities(content) : null;
}

export function titleTag(html: string): string | null {
    const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    return t ? decodeEntities(t) : null;
}

/** Fetch JSON from a public API (timeout + browser UA). Throws on non-2xx. */
export async function fetchJson<T>(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T> {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'DevEye-Dashboard', ...headers }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
}

/** Fetch a page's HTML, capped in size and time (OG tags live in <head>). */
export async function fetchHtmlCapped(url: string, maxBytes = 262_144): Promise<string> {
    const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
            // A real browser UA + consent cookies: many sites (Google/YouTube in
            // particular) otherwise serve a minimal bot page or an EU cookie-
            // consent interstitial whose OG tags are generic, not the target's.
            // `SOCS`/`CONSENT` skip Google's consent gate; `PREF=hl=en` forces
            // English so scraped labels (e.g. "subscribers") are predictable.
            'user-agent': BROWSER_UA,
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en-US,en;q=0.9',
            cookie: 'SOCS=CAI; CONSENT=YES+1; PREF=hl=en'
        }
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) throw new Error('not html');

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            total += value.length;
            if (total >= maxBytes) {
                await reader.cancel();
                break;
            }
        }
    }
    return Buffer.concat(chunks).toString('utf8');
}

import type { ShortcutPreview } from 'deveye-types';

/**
 * Shared building blocks for the shortcut-preview adapters (one per file in this
 * folder). An adapter turns a URL into a normalized {@link ShortcutPreview}.
 */
export interface TemplateAdapter {
    fetch(url: string): Promise<ShortcutPreview>;
}

export const EMPTY: ShortcutPreview = { ok: false, title: null, subtitle: null, imageUrl: null, stats: [] };

const FETCH_TIMEOUT_MS = 4500;
const BROWSER_UA =
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
 * SSRF guard: only fetch public http(s) hosts. Blocks loopback / private / link-
 * local addresses so a pasted URL can't probe the server's internal network.
 */
export function isSafePublicUrl(u: URL): boolean {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
}

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

function titleTag(html: string): string | null {
    const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    return t ? decodeEntities(t) : null;
}

/** Fetch JSON from a public API (timeout + browser UA). Throws on non-2xx. */
export async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

/**
 * Generic Open Graph + favicon preview, used by the `link` adapter and as a
 * fallback by the richer ones. Always yields at least the favicon + hostname.
 */
export async function openGraphPreview(url: string): Promise<ShortcutPreview> {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return EMPTY;
    }
    const host = u.hostname;
    const favicon = faviconUrl(host);
    if (!isSafePublicUrl(u)) {
        return { ok: true, title: host, subtitle: null, imageUrl: favicon, stats: [] };
    }
    let title = host;
    let subtitle: string | null = null;
    let imageUrl = favicon;
    try {
        const html = await fetchHtmlCapped(url);
        title = metaTag(html, 'og:title') ?? titleTag(html) ?? host;
        subtitle = metaTag(html, 'og:description') ?? metaTag(html, 'description') ?? metaTag(html, 'og:site_name');
        const ogImage = metaTag(html, 'og:image');
        if (ogImage) {
            const abs = new URL(ogImage, u).toString();
            if (isValidHttpUrl(abs)) imageUrl = abs;
        }
    } catch {
        // Keep the favicon + host fallback.
    }
    return { ok: true, title, subtitle, imageUrl, stats: [] };
}

interface OEmbed {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
}

/**
 * Generic oEmbed preview (title + author + thumbnail) for providers that expose
 * an endpoint. Falls back to Open Graph when the URL isn't oEmbeddable.
 */
export async function oembedPreview(endpoint: string, url: string): Promise<ShortcutPreview> {
    try {
        const data = await fetchJson<OEmbed>(`${endpoint}?format=json&url=${encodeURIComponent(url)}`);
        if (data.title) {
            return {
                ok: true,
                title: data.title,
                subtitle: data.author_name ?? null,
                imageUrl: data.thumbnail_url && isValidHttpUrl(data.thumbnail_url) ? data.thumbnail_url : null,
                stats: []
            };
        }
    } catch {
        // Not oEmbeddable (e.g. a profile/channel) — fall through to Open Graph.
    }
    return openGraphPreview(url);
}

import type { MailSuspiciousLink } from 'deveye-types';

/**
 * Cheap, local heuristics over the already-sanitized HTML — no external calls,
 * no metadata leaves the server. Flags for user awareness; never blocks a
 * click. `unsafe-scheme` links (javascript:/vbscript:/data:) are handled
 * structurally by {@link sanitizeMailHtml} instead (the scheme is stripped
 * outright, so there's nothing left here to flag).
 */

/** A short list of commonly-impersonated brands worth a typosquat check. */
const WATCHED_DOMAINS = [
    'paypal.com',
    'google.com',
    'microsoft.com',
    'apple.com',
    'amazon.com',
    'facebook.com',
    'instagram.com',
    'netflix.com',
    'bankofamerica.com',
    'wellsfargo.com',
    'chase.com',
    'dhl.com',
    'laposte.fr',
    'impots.gouv.fr',
    'ameli.fr'
];

function domainOf(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** Levenshtein edit distance, capped early once it exceeds `max` (this only ever needs small distances). */
function editDistanceWithin(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        let rowMin = prev[0];
        for (let j = 1; j <= b.length; j++) {
            const temp = prev[j];
            prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[j], prev[j - 1]);
            diag = temp;
            rowMin = Math.min(rowMin, prev[j]);
        }
        if (rowMin > max) return max + 1;
    }
    return prev[b.length];
}

/** Strip tags to get an anchor's plain visible text. */
function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').trim();
}

const ANCHOR_RE = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const URL_LIKE_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

export function findSuspiciousLinks(sanitizedHtml: string): MailSuspiciousLink[] {
    const out: MailSuspiciousLink[] = [];
    for (const match of sanitizedHtml.matchAll(ANCHOR_RE)) {
        const href = match[1];
        const text = stripTags(match[2]);
        const hrefDomain = domainOf(href);
        if (!hrefDomain || !text) continue;

        if (URL_LIKE_RE.test(text)) {
            const textDomain = domainOf(text.startsWith('http') ? text : `http://${text}`);
            if (textDomain && textDomain !== hrefDomain) {
                out.push({ text, href, reason: 'text-href-mismatch' });
                continue;
            }
        }

        for (const brand of WATCHED_DOMAINS) {
            if (hrefDomain === brand || hrefDomain.endsWith(`.${brand}`)) break;
            const distance = editDistanceWithin(hrefDomain, brand, 2);
            if (distance > 0 && distance <= 2) {
                out.push({ text, href, reason: 'lookalike-domain' });
                break;
            }
        }
    }
    return out;
}

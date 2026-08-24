import type { ShortcutPreview } from '@deveye/types';

import {
    decodeEntities,
    faviconUrl,
    fetchHtmlCapped,
    fetchJson,
    fmtCount,
    isSafePublicUrl,
    isValidHttpUrl,
    metaTag,
    relativeShort,
    titleTag
} from '../netFetch';

/**
 * Shared building blocks for the shortcut-preview adapters (one per file in this
 * folder). An adapter turns a URL into a normalized {@link ShortcutPreview}.
 *
 * Les primitives réseau elles-mêmes (garde SSRF, fetch bornés, extraction de
 * balises) vivent dans `Services/netFetch` : les sondes OSINT s'en servent
 * aussi, et un garde SSRF écrit deux fois est un garde qu'on corrigera une
 * fois. Elles sont réexportées ici pour que les adaptateurs de ce dossier
 * gardent un import unique.
 */
export {
    decodeEntities,
    faviconUrl,
    fetchHtmlCapped,
    fetchJson,
    fmtCount,
    isSafePublicUrl,
    isValidHttpUrl,
    metaTag,
    relativeShort
};

export interface TemplateAdapter {
    fetch(url: string): Promise<ShortcutPreview>;
}

export const EMPTY: ShortcutPreview = { ok: false, title: null, subtitle: null, imageUrl: null, stats: [] };

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

import {
    faviconUrl,
    fetchHtmlCapped,
    fetchJson,
    fmtCount,
    isValidHttpUrl,
    metaTag,
    openGraphPreview,
    type TemplateAdapter
} from './shared';

const OEMBED = 'https://www.youtube.com/oembed';

/** A watchable URL (video / short / live) — these are oEmbeddable. */
function isVideo(u: URL): boolean {
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return true;
    if (/^\/(watch|shorts|live|embed)\b/.test(u.pathname)) return true;
    return u.pathname === '/' && u.searchParams.has('v');
}

/** View count from a watch page (videoDetails is the reliable source). */
function extractViews(html: string): string | null {
    const raw = html.match(/"viewCount":"(\d+)"/);
    if (raw) return fmtCount(Number(raw[1]));
    const st = html.match(/"viewCount":\{[^{}]*?"simpleText":"([\d,.\s]+)/);
    if (st) {
        const n = Number(st[1].replace(/\D/g, ''));
        if (n) return fmtCount(n);
    }
    return null;
}

/** Subscriber count from a channel page (several layouts over the years). */
function extractSubscribers(html: string): string | null {
    const patterns = [
        /"subscriberCountText"\s*:\s*\{[^{}]*?"(?:simpleText|content)"\s*:\s*"([^"]+)"/i,
        /"([\d.,]+\s?[KMB]?)\s+(?:subscribers?|abonn[ée]s)"/i,
        /([\d.,]+\s?[KMB]?)\s+(?:subscribers?|abonn[ée]s)/i
    ];
    for (const re of patterns) {
        const num = html.match(re)?.[1]?.match(/[\d.,]+\s?[KMB]?/);
        if (num) return num[0].replace(/\s/g, '');
    }
    return null;
}

interface YtOEmbed {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
}

/**
 * YouTube preview.
 *  - Videos/shorts → oEmbed (title, channel, thumbnail; no key) + the view count
 *    scraped from the watch page → "<views> vues".
 *  - Channels/handles (not oEmbeddable) → scrape the page for name (og:title),
 *    avatar (og:image) and subscriber count.
 * Best-effort: a consent wall / layout change degrades to Open Graph.
 */
export const youtube: TemplateAdapter = {
    async fetch(url) {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return openGraphPreview(url);
        }

        if (isVideo(u)) {
            let title: string | null = null;
            let author: string | null = null;
            let thumb: string | null = null;
            try {
                const o = await fetchJson<YtOEmbed>(`${OEMBED}?format=json&url=${encodeURIComponent(url)}`);
                title = o.title ?? null;
                author = o.author_name ?? null;
                thumb = o.thumbnail_url ?? null;
            } catch {
                // oEmbed failed — try the page below.
            }
            let views: string | null = null;
            try {
                const html = await fetchHtmlCapped(url, 900_000);
                views = extractViews(html);
                title ??= metaTag(html, 'og:title');
                thumb ??= metaTag(html, 'og:image');
            } catch {
                // best-effort
            }
            if (!title) return openGraphPreview(url);
            return {
                ok: true,
                title,
                subtitle: author,
                imageUrl: thumb && isValidHttpUrl(thumb) ? thumb : faviconUrl('youtube.com'),
                stats: views ? [{ label: 'vues', value: views }] : []
            };
        }

        try {
            const html = await fetchHtmlCapped(url, 1_300_000);
            const title = metaTag(html, 'og:title');
            if (!title || title.toLowerCase() === 'youtube') return openGraphPreview(url);
            const image = metaTag(html, 'og:image');
            const subs = extractSubscribers(html);
            return {
                ok: true,
                title,
                subtitle: metaTag(html, 'og:description'),
                imageUrl: image && isValidHttpUrl(image) ? image : faviconUrl('youtube.com'),
                stats: subs ? [{ label: 'Abonnés', value: subs }] : []
            };
        } catch {
            return openGraphPreview(url);
        }
    }
};

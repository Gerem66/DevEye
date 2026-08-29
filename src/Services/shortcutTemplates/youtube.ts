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

/** Find the first "<count> <word>" near a channel header (subscribers / videos),
 *  across YouTube's various layouts. */
function extractCount(html: string, words: string): string | null {
    const patterns = [
        new RegExp(`"(?:simpleText|content|text)"\\s*:\\s*"([\\d.,]+\\s?[KMB]?)\\s+(?:${words})"`, 'i'),
        new RegExp(`([\\d.,]+\\s?[KMB]?)\\s+(?:${words})`, 'i')
    ];
    for (const re of patterns) {
        const num = html.match(re)?.[1]?.match(/[\d.,]+\s?[KMB]?/);
        if (num) return num[0].replace(/\s/g, '');
    }
    return null;
}

/** Subscriber count from a channel page (several layouts over the years). */
function extractSubscribers(html: string): string | null {
    const fromOld = html.match(/"subscriberCountText"\s*:\s*\{[^{}]*?"(?:simpleText|content)"\s*:\s*"([^"]+)"/i);
    const num = fromOld?.[1]?.match(/[\d.,]+\s?[KMB]?/);
    if (num) return num[0].replace(/\s/g, '');
    return extractCount(html, 'subscribers?|abonn[ée]s');
}

/**
 * Channel video count: structured header fields first, else the text right
 * after the subscriber count, plural "videos" only so a stray "1 video"
 * elsewhere on the page can't win.
 */
function extractVideos(html: string): string | null {
    const structured =
        html.match(/"videosCountText"\s*:\s*\{[^{}]*?"(?:simpleText|content)"\s*:\s*"([\d.,]+\s?[KMB]?)/i)?.[1] ??
        html.match(/"videosCountText"\s*:\s*\{[^{}]*?"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([\d.,]+\s?[KMB]?)/i)?.[1];
    if (structured) return structured.replace(/\s/g, '');

    const subIdx = html.search(/[\d.,]+\s?[KMB]?\s+subscribers/i);
    const slices = subIdx >= 0 ? [html.slice(subIdx, subIdx + 400)] : [];
    slices.push(html);
    for (const s of slices) {
        const m = s.match(/([\d.,]+\s?[KMB]?)\s+videos\b/i);
        if (m) return m[1].replace(/\s/g, '');
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
            const videos = extractVideos(html);
            const stats: { label: string; value: string }[] = [];
            if (subs) stats.push({ label: 'Abonnés', value: subs });
            if (videos) stats.push({ label: 'vidéos', value: videos });
            return {
                ok: true,
                title,
                subtitle: metaTag(html, 'og:description'),
                imageUrl: image && isValidHttpUrl(image) ? image : faviconUrl('youtube.com'),
                stats
            };
        } catch {
            return openGraphPreview(url);
        }
    }
};

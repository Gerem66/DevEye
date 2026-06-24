import { faviconUrl, fetchHtmlCapped, isValidHttpUrl, metaTag, openGraphPreview, type TemplateAdapter } from './shared';

/** Spotify pages put rich numbers in og:description, e.g. "Artist · 50M monthly
 *  listeners." or "Playlist · 120 songs". Pull out what's there. */
function statsFromDescription(desc: string | null): { label: string; value: string }[] {
    if (!desc) return [];
    const out: { label: string; value: string }[] = [];
    const listeners = desc.match(/([\d.,]+\s?[KMB]?)\s+monthly listeners/i);
    if (listeners) out.push({ label: 'auditeurs/mois', value: listeners[1].replace(/\s/g, '') });
    const songs = desc.match(/([\d.,]+)\s+(?:songs|tracks|items|episodes)/i);
    if (songs) out.push({ label: 'titres', value: songs[1] });
    const likes = desc.match(/([\d.,]+\s?[KMB]?)\s+(?:likes|saves)/i);
    if (likes) out.push({ label: 'likes', value: likes[1].replace(/\s/g, '') });
    return out.slice(0, 2);
}

/**
 * Spotify preview by scraping the (server-rendered) Open Graph tags: title +
 * cover art, and any numbers exposed in the description (monthly listeners,
 * track count…). Falls back to the generic preview on failure.
 */
export const spotify: TemplateAdapter = {
    async fetch(url) {
        try {
            const html = await fetchHtmlCapped(url);
            const title = metaTag(html, 'og:title');
            if (!title) return openGraphPreview(url);
            const image = metaTag(html, 'og:image');
            const desc = metaTag(html, 'og:description');
            return {
                ok: true,
                title,
                subtitle: desc,
                imageUrl: image && isValidHttpUrl(image) ? image : faviconUrl('spotify.com'),
                stats: statsFromDescription(desc)
            };
        } catch {
            return openGraphPreview(url);
        }
    }
};

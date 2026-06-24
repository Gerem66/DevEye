import { fetchJson, openGraphPreview, type TemplateAdapter } from './shared';

interface WikiSummary {
    title?: string;
    description?: string;
    extract?: string;
    thumbnail?: { source?: string };
}

/**
 * Wikipedia preview via the REST summary API: the article title, a short
 * description/extract and its lead image. Falls back to Open Graph for non-
 * article URLs.
 */
export const wikipedia: TemplateAdapter = {
    async fetch(url) {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return openGraphPreview(url);
        }
        const m = u.pathname.match(/\/wiki\/(.+)$/);
        if (!m) return openGraphPreview(url);
        try {
            const data = await fetchJson<WikiSummary>(`https://${u.hostname}/api/rest_v1/page/summary/${m[1]}`);
            if (!data.title) return openGraphPreview(url);
            return {
                ok: true,
                title: data.title,
                subtitle: data.description || data.extract || null,
                imageUrl: data.thumbnail?.source ?? null,
                stats: []
            };
        } catch {
            return openGraphPreview(url);
        }
    }
};

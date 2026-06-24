import {
    decodeEntities,
    faviconUrl,
    fetchJson,
    fmtCount,
    isValidHttpUrl,
    openGraphPreview,
    type TemplateAdapter
} from './shared';

interface RedditAbout {
    data?: {
        title?: string;
        display_name_prefixed?: string;
        public_description?: string;
        subscribers?: number;
        community_icon?: string;
        icon_img?: string;
        name?: string;
        subreddit?: { subscribers?: number; public_description?: string; icon_img?: string; community_icon?: string };
    };
}

// Reddit blocks generic/empty user-agents; a descriptive one is what they ask for.
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; DevEye-Dashboard/1.0)' };

/** Icon URLs come HTML-escaped (`&amp;`) and need their query (a signature) kept. */
function cleanIcon(s?: string): string | null {
    if (!s) return null;
    const d = decodeEntities(s);
    return isValidHttpUrl(d) ? d : null;
}

/**
 * Reddit preview. The normal pages now serve an anti-bot interstitial, so we use
 * the public `about.json` endpoints instead — a subreddit's members + icon, or a
 * user's followers + avatar. Falls back to Open Graph for other URLs (posts…).
 */
export const reddit: TemplateAdapter = {
    async fetch(url) {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return openGraphPreview(url);
        }
        const seg = u.pathname.split('/').filter(Boolean);
        try {
            if (seg[0] === 'r' && seg[1]) {
                const { data: d } = await fetchJson<RedditAbout>(
                    `https://www.reddit.com/r/${encodeURIComponent(seg[1])}/about.json`,
                    HEADERS
                );
                if (!d?.display_name_prefixed && !d?.title) return openGraphPreview(url);
                return {
                    ok: true,
                    title: d.display_name_prefixed || d.title || `r/${seg[1]}`,
                    subtitle: d.public_description || null,
                    imageUrl: cleanIcon(d.community_icon) ?? cleanIcon(d.icon_img) ?? faviconUrl('reddit.com'),
                    stats:
                        typeof d.subscribers === 'number' ? [{ label: 'membres', value: fmtCount(d.subscribers) }] : []
                };
            }
            if ((seg[0] === 'user' || seg[0] === 'u') && seg[1]) {
                const { data: d } = await fetchJson<RedditAbout>(
                    `https://www.reddit.com/user/${encodeURIComponent(seg[1])}/about.json`,
                    HEADERS
                );
                const subs = d?.subreddit?.subscribers;
                return {
                    ok: true,
                    title: `u/${d?.name || seg[1]}`,
                    subtitle: d?.subreddit?.public_description || null,
                    imageUrl: cleanIcon(d?.icon_img) ?? cleanIcon(d?.subreddit?.icon_img) ?? faviconUrl('reddit.com'),
                    stats: typeof subs === 'number' ? [{ label: 'abonnés', value: fmtCount(subs) }] : []
                };
            }
        } catch {
            // fall through to Open Graph
        }
        return openGraphPreview(url);
    }
};

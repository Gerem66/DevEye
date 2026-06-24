import type { ShortcutPreview, ShortcutTemplate } from 'deveye-types';
import { EMPTY, openGraphPreview, type TemplateAdapter } from './shared';
import { link } from './link';
import { github } from './github';
import { youtube } from './youtube';
import { spotify } from './spotify';
import { soundcloud } from './soundcloud';
import { tiktok } from './tiktok';
import { wikipedia } from './wikipedia';
import { npm } from './npm';
import { reddit } from './reddit';
import { twitch } from './twitch';

/**
 * Template → adapter registry. Sites with a real source (API / oEmbed / REST)
 * have a dedicated adapter file; the rest reuse the generic `link` (Open Graph +
 * favicon) adapter — which already gives them a proper preview — rather than
 * duplicating identical files. Add a `<name>.ts` adapter here when a site gains
 * a real handler.
 */
const ADAPTERS: Record<ShortcutTemplate, TemplateAdapter> = {
    link,
    github,
    youtube,
    spotify,
    soundcloud,
    tiktok,
    wikipedia,
    npm,
    reddit,
    twitch,
    // Open-Graph-only services (login walls / no public API — see the gallery):
    twitter: link,
    instagram: link,
    linkedin: link,
    discord: link,
    medium: link,
    dribbble: link,
    pinterest: link,
    facebook: link
};

/* ------------------------------- TTL cache -------------------------------- */

const TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

interface CachedPreview {
    preview: ShortcutPreview;
    expires: number;
}
const cache = new Map<string, CachedPreview>();

/**
 * Resolve a shortcut preview, served from the TTL cache when fresh. Best-effort:
 * a dedicated adapter failing falls back to the generic Open Graph preview, so a
 * tile always at least gets an icon — never an error.
 */
export async function fetchShortcutPreview(
    template: ShortcutTemplate,
    url: string,
    refresh = false
): Promise<ShortcutPreview> {
    const key = `${template}|${url}`;
    const now = Date.now();

    const hit = cache.get(key);
    // `refresh` (Ctrl/Cmd-click on the tile) forces a re-fetch past the TTL.
    if (!refresh && hit && hit.expires > now) return hit.preview;
    if (hit) cache.delete(key);

    let preview: ShortcutPreview;
    try {
        preview = await (ADAPTERS[template] ?? link).fetch(url);
    } catch {
        try {
            preview = await openGraphPreview(url);
        } catch {
            preview = EMPTY;
        }
    }

    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { preview, expires: now + TTL_MS });
    return preview;
}

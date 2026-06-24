import { openGraphPreview, type TemplateAdapter } from './shared';

/**
 * Generic link: an Open Graph + favicon preview. This is the fallback adapter —
 * any site without a dedicated handler (and any unknown domain) uses it, and it
 * already yields a proper preview (title, description, image) for the many sites
 * that expose Open Graph tags.
 */
export const link: TemplateAdapter = {
    fetch: (url) => openGraphPreview(url)
};

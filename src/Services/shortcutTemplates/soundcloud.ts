import { oembedPreview, type TemplateAdapter } from './shared';

/** SoundCloud preview via oEmbed (track / playlist / user: title + artwork). */
export const soundcloud: TemplateAdapter = {
    fetch: (url) => oembedPreview('https://soundcloud.com/oembed', url)
};

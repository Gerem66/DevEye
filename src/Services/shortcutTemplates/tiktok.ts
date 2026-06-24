import { oembedPreview, type TemplateAdapter } from './shared';

/** TikTok preview via oEmbed (video: title, author + thumbnail). */
export const tiktok: TemplateAdapter = {
    fetch: (url) => oembedPreview('https://www.tiktok.com/oembed', url)
};

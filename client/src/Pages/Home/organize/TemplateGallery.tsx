import { useEffect, useState } from 'react';
import { ws } from '@/api/ws';
import type { ShortcutItem, ShortcutPreview, ShortcutTemplate } from 'deveye-types';
import { Widget } from '@/Components/Widget';
import { ShortcutTile } from '../tiles/ShortcutTile';
import styles from './organize.module.css';

/**
 * One known, real example per coded template — used by the test gallery so each
 * adapter can be checked in real conditions: the actual final tile is rendered
 * below a small test header (name / status / link to the real page).
 */
const EXAMPLES: { template: ShortcutTemplate; label: string; url: string }[] = [
    { template: 'github', label: 'GitHub — dépôt', url: 'https://github.com/facebook/react' },
    { template: 'github', label: 'GitHub — profil', url: 'https://github.com/torvalds' },
    { template: 'youtube', label: 'YouTube — chaîne', url: 'https://www.youtube.com/@mkbhd' },
    { template: 'youtube', label: 'YouTube — vidéo', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { template: 'twitch', label: 'Twitch', url: 'https://www.twitch.tv/pokimane' },
    { template: 'twitter', label: 'X', url: 'https://x.com/NASA' },
    { template: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/nasa' },
    { template: 'tiktok', label: 'TikTok', url: 'https://www.tiktok.com/@khaby.lame' },
    { template: 'reddit', label: 'Reddit', url: 'https://www.reddit.com/r/programming' },
    { template: 'linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com/in/williamhgates' },
    { template: 'spotify', label: 'Spotify', url: 'https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02' },
    { template: 'soundcloud', label: 'SoundCloud', url: 'https://soundcloud.com/octobersveryown' },
    { template: 'discord', label: 'Discord', url: 'https://discord.gg/discord-developers' },
    { template: 'wikipedia', label: 'Wikipédia', url: 'https://en.wikipedia.org/wiki/Linux' },
    { template: 'medium', label: 'Medium', url: 'https://medium.com/@quincylarson' },
    { template: 'npm', label: 'npm', url: 'https://www.npmjs.com/package/react' },
    { template: 'dribbble', label: 'Dribbble', url: 'https://dribbble.com/dropbox' },
    { template: 'pinterest', label: 'Pinterest', url: 'https://www.pinterest.com/nasa' },
    { template: 'facebook', label: 'Facebook', url: 'https://www.facebook.com/NASA' },
    {
        template: 'link',
        label: 'Lien générique (Open Graph)',
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript'
    }
];

type State = 'loading' | ShortcutPreview | 'error';

function GalleryRow({ template, label, url }: { template: ShortcutTemplate; label: string; url: string }) {
    // The status badge comes from a direct fetch; the render below is the real
    // tile (which fetches the same cached preview), so the two never disagree.
    const [state, setState] = useState<State>('loading');

    useEffect(() => {
        let cancelled = false;
        let off: (() => void) | undefined;
        const run = () => {
            ws.send('home.shortcutPreview', { template, url })
                .then((res) => {
                    if (!cancelled) setState(res);
                })
                .catch(() => {
                    if (!cancelled) setState('error');
                });
        };
        if (ws.state === 'open') run();
        else
            off = ws.onStateChange((s) => {
                if (s === 'open') {
                    off?.();
                    off = undefined;
                    run();
                }
            });
        return () => {
            cancelled = true;
            off?.();
        };
    }, [template, url]);

    const preview = state !== 'loading' && state !== 'error' ? state : null;
    const rich = !!preview?.ok && (!!preview.imageUrl || (!!preview.title && preview.stats.length > 0));

    const item: ShortcutItem = { id: `${template}-${url}`, template, url, title: '' };

    return (
        <div className={styles.galleryRow}>
            {/* Test header — outside the preview. */}
            <div className={styles.galleryHead}>
                <span className={styles.galleryLabel}>{label}</span>
                <span
                    className={`${styles.galleryStatus} ${
                        state === 'loading' ? '' : state === 'error' ? styles.galleryKo : rich ? styles.galleryOk : ''
                    }`}
                >
                    {state === 'loading' ? '…' : state === 'error' ? 'erreur' : rich ? 'OK' : 'générique'}
                </span>
                <a className={styles.galleryUrl} href={url} target='_blank' rel='noopener noreferrer'>
                    Ouvrir ↗
                </a>
            </div>

            {/* The actual final tile. */}
            <div className={styles.galleryRender}>
                <Widget widgetId={item.id} slim interactive={false}>
                    <ShortcutTile item={item} />
                </Widget>
            </div>
        </div>
    );
}

/** Test gallery: every coded template with a real example + its final tile. */
export function TemplateGallery() {
    return (
        <div className={styles.gallery}>
            {EXAMPLES.map((e) => (
                <GalleryRow key={`${e.template}-${e.url}`} {...e} />
            ))}
        </div>
    );
}

export default TemplateGallery;

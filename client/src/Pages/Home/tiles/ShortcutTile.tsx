import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useState } from 'react';
import { ws } from '@/api/ws';
import type { ShortcutItem, ShortcutPreview } from '@deveye/types';
import { isForceReload } from '../forceReload';
import styles from './tiles.module.css';

/** The link's own favicon — its real brand logo, whatever the site. */
function hostFavicon(url: string): string | null {
    try {
        return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
    } catch {
        return null;
    }
}

export interface ShortcutTileProps {
    item: ShortcutItem;
    /** Hide the corner type badge (in edit mode it would sit under the action buttons). */
    hideBadge?: boolean;
}

/**
 * Compact "thin & long" card body for a user-pinned link (the surrounding Widget
 * is the `<a href>`). The **main** image is the target's own logo (account
 * avatar / og:image / favicon); a small **type** badge (the service's logo) sits
 * top-right. The user's title is optional — it falls back to the fetched name.
 */
export function ShortcutTile({ item, hideBadge }: ShortcutTileProps) {
    const [preview, setPreview] = useState<ShortcutPreview | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            ws.send('home.shortcutPreview', { template: item.template, url: item.url })
                .then((res) => {
                    if (!cancelled) setPreview(res);
                })
                .catch(() => {});
        };
        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [item.template, item.url]);

    // Ctrl/Cmd-click refreshes the preview (bypasses the server cache) instead of
    // opening the link — the click bubbles to the Widget anchor, so preventDefault
    // stops the navigation. Mirrors the Ctrl/Cmd force-reload on feature popups.
    const onClick = useCallback(
        (e: ReactMouseEvent) => {
            if (!isForceReload(e)) return;
            e.preventDefault();
            setRefreshing(true);
            ws.send('home.shortcutPreview', { template: item.template, url: item.url, refresh: true })
                .then(setPreview)
                .catch(() => {})
                .finally(() => setRefreshing(false));
        },
        [item.template, item.url]
    );

    const favicon = hostFavicon(item.url);
    const realImage = preview?.imageUrl ?? null;
    // Main logo: the target's own avatar/og:image when we have one, else the site
    // favicon (so we never fall back to a bland generic glyph).
    const image = realImage ?? favicon;
    const subtitle = item.description || preview?.subtitle || null;
    const stats = preview?.stats ?? [];
    const host = (() => {
        try {
            return new URL(item.url).hostname.replace(/^www\./, '');
        } catch {
            return item.url;
        }
    })();
    const displayTitle = item.title || preview?.title || host;
    // Show the type badge only when the main image is a real avatar — otherwise
    // the main image is already the favicon and the badge would duplicate it.
    const showBadge = !hideBadge && !!realImage && !!favicon;
    // Live/online status dot (e.g. Twitch), sat just left of the type badge.
    // Hidden in edit mode, where the action buttons occupy that corner.
    const status = !hideBadge ? (preview?.status ?? null) : null;

    return (
        <div className={`${styles.shortcut} ${refreshing ? styles.refreshing : ''}`} onClick={onClick}>
            {/* Status dot + small service logo in the corner. */}
            {status && (
                <span
                    className={`${styles.statusDot} ${status === 'online' ? styles.statusOnline : styles.statusOffline}`}
                    aria-label={status === 'online' ? 'En ligne' : 'Hors ligne'}
                    title={status === 'online' ? 'En ligne' : 'Hors ligne'}
                />
            )}
            {showBadge && (
                <span className={styles.typeBadge} aria-hidden='true'>
                    <img className={styles.typeBadgeImg} src={favicon} alt='' referrerPolicy='no-referrer' />
                </span>
            )}

            <div className={styles.shortcutHead}>
                {image ? (
                    // no-referrer so Google/YouTube avatar hosts (googleusercontent) don't 403.
                    <img
                        className={styles.shortcutImg}
                        src={image}
                        alt=''
                        loading='lazy'
                        referrerPolicy='no-referrer'
                    />
                ) : (
                    <span className={styles.shortcutIcon}>
                        <span className={`icon icon-${item.icon || 'other'} ${styles.shortcutGlyph}`} />
                    </span>
                )}
                <span className={styles.shortcutTitle}>{displayTitle}</span>
            </div>

            {subtitle && <span className={styles.shortcutDesc}>{subtitle}</span>}

            {stats.length > 0 && (
                <div className={styles.shortcutStats}>
                    {stats.map((s) => (
                        <span key={s.label} className={styles.shortcutStat}>
                            <strong>{s.value}</strong> {s.label}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

export default ShortcutTile;

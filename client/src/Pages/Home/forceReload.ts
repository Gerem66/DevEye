/**
 * Force-reload modifier: Cmd on macOS (Ctrl+click there opens the context menu),
 * Ctrl elsewhere. Used to force-refresh a feature popup on open, and a shortcut
 * tile's preview on click.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

export function isForceReload(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
    return IS_MAC ? e.metaKey : e.ctrlKey;
}

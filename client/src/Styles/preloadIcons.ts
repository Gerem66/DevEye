/**
 * Warm the browser cache with every UI icon at first load. Icons are SVGs applied
 * as CSS `mask-image`, so a browser fetches each one only when an element using it
 * first renders; that leaves the WS-reconnect overlay's icons unreachable, since
 * they would need fetching exactly when the connection is down.
 *
 * `icons.css` stays the single source of truth: the URLs are read from the loaded
 * stylesheets (CSSOM), so adding an icon to the CSS preloads it with no list to
 * keep in sync here.
 */

/** Pull every `/icons/*.svg` URL declared as a (webkit-)mask-image in the CSSOM. */
function collectIconUrls(): Set<string> {
    const urls = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            // Cross-origin stylesheet: its rules aren't readable. Ours are same-origin.
            continue;
        }
        for (const rule of Array.from(rules)) {
            if (!(rule instanceof CSSStyleRule)) continue;
            const mask = rule.style.getPropertyValue('mask-image') || rule.style.getPropertyValue('-webkit-mask-image');
            const match = mask.match(/url\(["']?([^"')]+\.svg)["']?\)/);
            if (match && match[1].includes('/icons/')) urls.add(match[1]);
        }
    }
    return urls;
}

/** Fetch (cache) every icon once. A bare `Image` GET is enough to populate the cache. */
function warmCache(): void {
    for (const url of collectIconUrls()) {
        const img = new Image();
        img.src = url;
    }
}

/**
 * Preload all icons once the document and its stylesheets are parsed, so the CSSOM
 * scan sees every rule.
 */
export function preloadIcons(): void {
    if (document.readyState === 'complete') warmCache();
    else window.addEventListener('load', warmCache, { once: true });
}

import sanitizeHtml from 'sanitize-html';

/**
 * Server-side HTML sanitization for mail bodies: the client never receives raw
 * remote HTML. Strict allowlist by default, no `<script>`, no inline event
 * handlers, no `style`/`<style>` (the simplest reliable defense against
 * CSS-based tracking beacons and layout tricks). Remote images are rewritten to
 * an inert `data-blocked-src` placeholder unless the caller allowed them,
 * globally or by trusted hostname.
 *
 * `preserveStyling` (the "raw" body render mode) relaxes the allowlist to keep
 * `<style>`/inline `style=""`, on the understanding the client only ever shows
 * that HTML inside a sandboxed, script-disabled iframe. Scripts and handlers
 * stay stripped either way.
 */

const ALLOWED_TAGS = [
    'a',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'p',
    'br',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'span',
    'div',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img'
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
    // `target`/`rel` are added by the transform below, never taken from the message.
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'data-blocked-src'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan']
};

function isRemote(src: string): boolean {
    return /^https?:\/\//i.test(src);
}

function hostnameOf(src: string): string | null {
    try {
        return new URL(src).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function isTrusted(hostname: string | null, trustedDomains: string[]): boolean {
    if (!hostname) return false;
    return trustedDomains.some((d) => {
        const domain = d.toLowerCase();
        return hostname === domain || hostname.endsWith(`.${domain}`);
    });
}

export interface SanitizeOptions {
    allowRemoteImages: boolean;
    /** Hostnames that bypass blocking regardless of `allowRemoteImages`. */
    trustedDomains: string[];
    /** Keep `<style>`/`style=""` for the sandboxed "raw" render mode. */
    preserveStyling: boolean;
}

export interface SanitizeResult {
    html: string;
    /** True when at least one remote image was rewritten to a blocked placeholder. */
    remoteImagesBlocked: boolean;
    /** Distinct hostnames of the images that got blocked, for a "trust these" picker. */
    blockedSources: string[];
}

export function sanitizeMailHtml(rawHtml: string, opts: SanitizeOptions): SanitizeResult {
    let remoteImagesBlocked = false;
    const blockedHosts = new Set<string>();

    const allowedTags = opts.preserveStyling ? [...ALLOWED_TAGS, 'style'] : ALLOWED_TAGS;
    const allowedAttributes: sanitizeHtml.IOptions['allowedAttributes'] = opts.preserveStyling
        ? { ...ALLOWED_ATTRIBUTES, '*': ['style'] }
        : ALLOWED_ATTRIBUTES;

    let html = sanitizeHtml(rawHtml, {
        allowedTags,
        allowedAttributes,
        // `preserveStyling` puts `<style>` on the allowlist, which sanitize-html
        // warns about. Answered here: that mode only feeds the `raw` renderer,
        // whose result goes in a `sandbox=""` iframe, remote `url(...)` refs are
        // stripped below, and scripts and handlers go in both modes. The flag
        // silences a warning already answered; it relaxes nothing.
        allowVulnerableTags: opts.preserveStyling,
        // No 'data' scheme: kills CSS/style smuggling and most phishing tricks
        // that rely on lookalike-content URIs.
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesAppliedToAttributes: ['href', 'src'],
        disallowedTagsMode: 'discard',
        transformTags: {
            // In `embedded` mode the body is rendered inline in the SPA, where a
            // plain link would navigate the whole app away on a single click, to
            // a destination that came out of an untrusted email. Every link opens
            // in a new tab instead, with `noopener` so the target can never reach
            // back through `window.opener`.
            a: (_tagName, attribs) => ({
                tagName: 'a',
                attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' }
            }),
            img: (_tagName, attribs) => {
                const src = attribs.src ?? '';
                const trusted = isTrusted(hostnameOf(src), opts.trustedDomains);
                if (isRemote(src) && !opts.allowRemoteImages && !trusted) {
                    remoteImagesBlocked = true;
                    const host = hostnameOf(src);
                    if (host) blockedHosts.add(host);
                    const { src: _dropped, ...rest } = attribs;
                    return { tagName: 'img', attribs: { ...rest, 'data-blocked-src': src } };
                }
                return { tagName: 'img', attribs };
            }
        }
    });

    // `<style>`/`style=""` content isn't parsed as CSS above, so a
    // `background-image: url(...)` could still act as a tracking pixel in `raw`
    // mode. Best-effort text-level strip, same trust rules as the `<img>` pass.
    if (opts.preserveStyling && !opts.allowRemoteImages) {
        html = html.replace(/url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi, (match, _quote: string, url: string) => {
            const host = hostnameOf(url);
            if (isTrusted(host, opts.trustedDomains)) return match;
            remoteImagesBlocked = true;
            if (host) blockedHosts.add(host);
            return 'url(none)';
        });
    }

    return { html, remoteImagesBlocked, blockedSources: Array.from(blockedHosts) };
}

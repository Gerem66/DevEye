import { faviconUrl, fetchJson, fmtCount, openGraphPreview, relativeShort, type TemplateAdapter } from './shared';

interface NpmPackument {
    name?: string;
    description?: string;
    'dist-tags'?: { latest?: string };
    time?: { modified?: string };
}
interface NpmDownloads {
    downloads?: number;
}

/**
 * npm package preview via the registry: description, latest version and weekly
 * downloads. Falls back to Open Graph for non-package URLs.
 */
export const npm: TemplateAdapter = {
    async fetch(url) {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return openGraphPreview(url);
        }
        // .../package/<name> or .../package/@scope/<name>
        const m = u.pathname.match(/\/package\/((?:@[^/]+\/)?[^/]+)/);
        if (!m) return openGraphPreview(url);
        const name = decodeURIComponent(m[1]);
        try {
            const pkg = await fetchJson<NpmPackument>(`https://registry.npmjs.org/${name}`);
            if (!pkg.name) return openGraphPreview(url);
            const stats = [];
            if (pkg['dist-tags']?.latest) stats.push({ label: 'version', value: `v${pkg['dist-tags'].latest}` });
            try {
                const dl = await fetchJson<NpmDownloads>(`https://api.npmjs.org/downloads/point/last-week/${name}`);
                if (typeof dl.downloads === 'number') stats.push({ label: '/sem.', value: fmtCount(dl.downloads) });
            } catch {
                // downloads are optional
            }
            const updated = pkg.time?.modified ? relativeShort(pkg.time.modified) : null;
            if (updated) stats.push({ label: 'maj', value: updated });
            return {
                ok: true,
                title: pkg.name,
                subtitle: pkg.description ?? null,
                imageUrl: faviconUrl('npmjs.com'),
                stats
            };
        } catch {
            return openGraphPreview(url);
        }
    }
};

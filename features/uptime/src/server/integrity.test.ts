import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IntegrityBaseline } from './_shared';
import {
    captureSite,
    describeDrift,
    detailDrift,
    diffCapture,
    filesOfPage,
    hasDrift,
    INTEGRITY_FILES_MAX,
    type FetchedFile,
    type FetchFn
} from './integrity';

/**
 * La sonde d'intégrité, sans réseau : la lecture est un dictionnaire d'URL. Ce
 * qui se vérifie est ce qui ferait mentir la référence : un fichier oublié
 * (manifeste, page, chemin ajouté), une origine étrangère prise pour la nôtre,
 * un écart qui passerait inaperçu.
 */

const ORIGIN = 'https://app.exemple.fr';

function file(sha256: string, over: Partial<FetchedFile> = {}): FetchedFile {
    return { status: 200, sha256, csp: null, text: null, ...over };
}

/** Une lecture qui ne connaît que ses adresses ; toute autre est un 404 vide. */
function siteOf(files: Record<string, FetchedFile>): FetchFn & { asked: string[] } {
    const asked: string[] = [];
    const fetch: FetchFn = async (url) => {
        asked.push(url);
        return files[url] ?? file('deadbeef', { status: 404 });
    };
    return Object.assign(fetch, { asked });
}

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/index-abc.css">
<link rel=modulepreload href='/assets/vendor-def.js'>
<link rel="icon" href="/favicon.ico">
<script type="module" src="/assets/index-abc.js"></script>
<script src="https://cdn.tiers.example/lib.js"></script>
<script src="data:text/javascript,1"></script>
</head><body></body></html>`;

describe('filesOfPage', () => {
    it('relève scripts, styles et préchargements de même origine, rien d’autre', () => {
        assert.deepEqual(filesOfPage(PAGE, `${ORIGIN}/`), [
            '/assets/index-abc.css',
            '/assets/index-abc.js',
            '/assets/vendor-def.js'
        ]);
    });

    it('résout les chemins relatifs à la page', () => {
        assert.deepEqual(filesOfPage('<script src="app.js"></script>', `${ORIGIN}/admin/`), ['/admin/app.js']);
    });
});

describe('captureSite', () => {
    it('suit le manifeste de build quand le site en annonce un, manifeste compris', async () => {
        const manifest = JSON.stringify({
            format: 1,
            version: '1.0.0',
            files: { 'index.html': 'a'.repeat(64), 'assets/feature-x.js': 'b'.repeat(64) }
        });
        const fetch = siteOf({
            [`${ORIGIN}/`]: file('h-index', { csp: "default-src 'self'", text: PAGE }),
            [`${ORIGIN}/.well-known/deveye-build.json`]: file('h-manifest', { text: manifest }),
            [`${ORIGIN}/assets/feature-x.js`]: file('h-feature'),
            [`${ORIGIN}/t.js`]: file('h-tracker')
        });
        const capture = await captureSite(`${ORIGIN}/`, ['/t.js', ' ', 'sans-barre'], 5000, fetch);
        assert.equal(capture.source, 'manifest');
        assert.equal(capture.csp, "default-src 'self'");
        assert.deepEqual(capture.files, {
            '/': 'h-index',
            '/.well-known/deveye-build.json': 'h-manifest',
            '/assets/feature-x.js': 'h-feature',
            '/t.js': 'h-tracker'
        });
        // Les scripts de la page ne sont pas relus en plus : le manifeste fait foi.
        assert.ok(!fetch.asked.includes(`${ORIGIN}/assets/index-abc.js`));
    });

    it('sans manifeste, lit la page et ce qu’elle charge', async () => {
        const fetch = siteOf({
            [`${ORIGIN}/`]: file('h-index', { text: PAGE }),
            [`${ORIGIN}/assets/index-abc.css`]: file('h-css'),
            [`${ORIGIN}/assets/index-abc.js`]: file('h-js'),
            [`${ORIGIN}/assets/vendor-def.js`]: file('h-vendor')
        });
        const capture = await captureSite(`${ORIGIN}/`, [], 5000, fetch);
        assert.equal(capture.source, 'page');
        assert.deepEqual(Object.keys(capture.files).sort(), [
            '/',
            '/assets/index-abc.css',
            '/assets/index-abc.js',
            '/assets/vendor-def.js'
        ]);
    });

    it('refuse un document en erreur, et un manifeste malformé retombe sur la page', async () => {
        await assert.rejects(
            captureSite(`${ORIGIN}/`, [], 5000, siteOf({ [`${ORIGIN}/`]: file('x', { status: 503, text: '' }) })),
            /503/
        );
        const fetch = siteOf({
            [`${ORIGIN}/`]: file('h-index', { text: '<script src="/a.js"></script>' }),
            [`${ORIGIN}/.well-known/deveye-build.json`]: file('h', { text: '{"format":1,"files":{"../x":"y"}}' }),
            [`${ORIGIN}/a.js`]: file('h-a')
        });
        const capture = await captureSite(`${ORIGIN}/`, [], 5000, fetch);
        assert.equal(capture.source, 'page');
        assert.deepEqual(Object.keys(capture.files).sort(), ['/', '/a.js']);
    });

    it('un fichier refusé fait échouer la relève plutôt que de passer pour modifié', async () => {
        const fetch = siteOf({
            [`${ORIGIN}/`]: file('h-index', { text: '<script src="/a.js"></script>' }),
            [`${ORIGIN}/a.js`]: file('h-refus', { status: 429 })
        });
        await assert.rejects(captureSite(`${ORIGIN}/`, [], 5000, fetch), /429/);
    });

    it('refuse une liste au-delà du plafond plutôt que de la vérifier à moitié', async () => {
        const files = Object.fromEntries(
            Array.from({ length: INTEGRITY_FILES_MAX + 1 }, (_, i) => [`assets/${i}.js`, 'c'.repeat(64)])
        );
        const fetch = siteOf({
            [`${ORIGIN}/`]: file('h-index', { text: '' }),
            [`${ORIGIN}/.well-known/deveye-build.json`]: file('h', {
                text: JSON.stringify({ format: 1, version: '1', files })
            })
        });
        await assert.rejects(captureSite(`${ORIGIN}/`, [], 5000, fetch), /Plus de/);
    });
});

describe('diffCapture', () => {
    const baseline: IntegrityBaseline = {
        capturedAt: 1,
        csp: "script-src 'self'",
        files: { '/': 'a', '/x.js': 'b', '/gone.js': 'c' },
        source: 'page'
    };

    it('nomme le modifié, l’ajouté, le retiré, et la politique', () => {
        const diff = diffCapture(baseline, {
            csp: "script-src 'self' 'unsafe-inline'",
            files: { '/': 'a', '/x.js': 'B', '/new.js': 'd' },
            source: 'page',
            documentStatus: 200
        });
        assert.deepEqual(diff, { changed: ['/x.js'], added: ['/new.js'], removed: ['/gone.js'], cspChanged: true });
        assert.equal(hasDrift(diff), true);
        assert.equal(
            describeDrift(diff),
            'Intégrité : 1 fichier modifié, 1 fichier ajouté, 1 fichier retiré, politique de contenu modifiée'
        );
        assert.deepEqual(detailDrift(diff), [
            'Modifié : /x.js',
            'Ajouté : /new.js',
            'Retiré : /gone.js',
            'Politique de contenu (CSP) modifiée'
        ]);
    });

    it('ne voit aucun écart quand rien n’a bougé', () => {
        const diff = diffCapture(baseline, { ...baseline, documentStatus: 200 });
        assert.equal(hasDrift(diff), false);
    });

    it('borne le détail pour qu’une alerte se lise', () => {
        const diff = {
            changed: Array.from({ length: 25 }, (_, i) => `/f${i}.js`),
            added: [],
            removed: [],
            cspChanged: false
        };
        const lines = detailDrift(diff, 20);
        assert.equal(lines.length, 21);
        assert.match(lines[20], /5 autre/);
    });
});

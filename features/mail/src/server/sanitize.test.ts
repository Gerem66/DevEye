import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeMailHtml } from './sanitize';

/**
 * La barrière HTML des corps de message : ce qui doit tomber tombe quel que
 * soit le mode, les images distantes ne se chargent que sur permission, et le
 * mode `raw` ne relâche que le style.
 */

const opts = { allowRemoteImages: false, trustedDomains: [] as string[], preserveStyling: false };

describe('sanitizeMailHtml', () => {
    it('retire scripts, gestionnaires et styles, et ouvre chaque lien dans un nouvel onglet sans opener', () => {
        const { html } = sanitizeMailHtml(
            '<p onclick="x()" style="color:red">Bonjour <a href="https://exemple.fr">lien</a></p><script>alert(1)</script><style>p{}</style>',
            opts
        );
        assert.equal(
            html,
            '<p>Bonjour <a href="https://exemple.fr" target="_blank" rel="noopener noreferrer nofollow">lien</a></p>'
        );
    });

    it('neutralise une image distante, en retient l’hôte, et laisse passer un domaine approuvé', () => {
        const blocked = sanitizeMailHtml('<img src="https://pixel.tracker.fr/p.gif" alt="">', opts);
        assert.equal(blocked.remoteImagesBlocked, true);
        assert.deepEqual(blocked.blockedSources, ['pixel.tracker.fr']);
        assert.ok(blocked.html.includes('data-blocked-src="https://pixel.tracker.fr/p.gif"'));
        assert.ok(!blocked.html.includes(' src='));

        const trusted = sanitizeMailHtml('<img src="https://cdn.exemple.fr/logo.png">', {
            ...opts,
            trustedDomains: ['exemple.fr']
        });
        assert.equal(trusted.remoteImagesBlocked, false);
        assert.ok(trusted.html.includes('src="https://cdn.exemple.fr/logo.png"'));
    });

    it('refuse les schémas autres que http(s) et mailto', () => {
        const { html } = sanitizeMailHtml(
            '<a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AAAA">',
            opts
        );
        assert.ok(!html.includes('javascript:'));
        assert.ok(!html.includes('data:'));
    });

    it('en mode `raw`, garde le style mais éteint les `url(...)` distantes non approuvées', () => {
        const { html, remoteImagesBlocked, blockedSources } = sanitizeMailHtml(
            '<style>.a{background:url("https://pixel.tracker.fr/b.png")}</style><p style="color:red">x</p>',
            { ...opts, preserveStyling: true }
        );
        assert.ok(html.includes('<style>'));
        assert.ok(html.includes('style="color:red"'));
        assert.ok(html.includes('url(none)'));
        assert.equal(remoteImagesBlocked, true);
        assert.deepEqual(blockedSources, ['pixel.tracker.fr']);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderMissing, renderStatus } from './render';
import type { StatusView } from './view';

const view: StatusView = {
    generatedAt: 1_700_000_000,
    feature: null,
    banner: { tone: 'maintenance', title: 'DevEye est en maintenance', detail: null, message: 'Retour <b>vite</b>' },
    components: [],
    ongoing: [
        {
            label: 'Application DevEye',
            state: 'maintenance',
            reason: null,
            message: null,
            startedAt: 1_699_999_000,
            endedAt: null
        }
    ],
    history: [],
    picker: [{ id: 'x-rdv', label: 'Rendez-vous & co', state: 'up' }]
};

const options = { siteUrl: 'https://deveye.fr', appUrl: 'https://app.deveye.fr' };

describe('renderStatus', () => {
    it('échappe ce qui vient de DevEye, et ne met aucun script en ligne', () => {
        const html = renderStatus(view, options);
        assert.ok(html.includes('Retour &lt;b&gt;vite&lt;/b&gt;'));
        assert.ok(html.includes('Rendez-vous &amp; co'));
        assert.ok(!/<script>/.test(html));
        assert.ok(html.includes('<script src="/page.js" defer></script>'));
    });

    it('le sélecteur mène à la page de chaque fonctionnalité', () => {
        const html = renderStatus(view, options);
        assert.ok(html.includes('href="/x-rdv"'));
        assert.ok(html.includes('Maintenance depuis le'));
    });
});

describe('renderMissing', () => {
    it('renvoie vers la vue d’ensemble', () => {
        assert.ok(renderMissing(options).includes('href="/"'));
    });
});

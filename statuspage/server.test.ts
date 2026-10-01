import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createStatusServer } from './server';
import type { StatusView } from './view';

const VIEW: StatusView = {
    generatedAt: 1_700_000_000,
    feature: null,
    banner: { tone: 'up', title: 'Tous les services fonctionnent', detail: null, message: null },
    components: [],
    ongoing: [],
    history: [],
    picker: []
};

describe('createStatusServer', () => {
    let base = '';
    let lastTick = Math.floor(Date.now() / 1000);
    let tracking: { key: string; origin: string } | null = null;
    const server = createStatusServer({
        view: (id) =>
            id === null || id === 'notes' || id === 'uptime'
                ? { ...VIEW, feature: id ? { id, label: 'Notes' } : null }
                : null,
        render: { siteUrl: null, appUrl: 'https://app.deveye.fr' },
        tracking: () => tracking,
        icon: Buffer.from('png'),
        lastTick: () => lastTick
    });

    before(async () => {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('sert la vue d’ensemble et chaque fonctionnalité, sous une politique stricte', async () => {
        const home = await fetch(`${base}/`);
        assert.equal(home.status, 200);
        assert.match(home.headers.get('content-security-policy') ?? '', /script-src 'self'/);
        assert.equal((await fetch(`${base}/notes`)).status, 200);
    });

    it('la balise ouvre la politique à sa seule origine, sur la page qui la porte', async () => {
        tracking = { key: 'pk_test', origin: 'https://api.deveye.fr' };
        // Un chemin pas encore en cache : la page gardée 15 s a été rendue sans balise.
        const notes = await fetch(`${base}/uptime`);
        const policy = notes.headers.get('content-security-policy') ?? '';
        assert.match(policy, /script-src 'self' https:\/\/api\.deveye\.fr;/);
        assert.match(policy, /connect-src 'self' https:\/\/api\.deveye\.fr;/);
        assert.ok((await notes.text()).includes('https://api.deveye.fr/t.js'));
        const missing = await fetch(`${base}/inconnue`);
        assert.match(missing.headers.get('content-security-policy') ?? '', /script-src 'self';/);
        tracking = null;
    });

    it('un chemin inconnu est une page introuvable', async () => {
        assert.equal((await fetch(`${base}/inconnue`)).status, 404);
        assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404);
        assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
    });

    it('le script et la sonde de vie', async () => {
        assert.equal((await fetch(`${base}/page.js`)).status, 200);
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        lastTick = 0;
        assert.equal((await fetch(`${base}/healthz`)).status, 503);
    });
});

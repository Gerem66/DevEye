import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProxyConfig } from './proxy';
import type { WebSeam } from './web';

const HERE = '203.0.113.7';
const SETTINGS = { upstream: 'http://deveye-server:3001', certResolver: 'letsencrypt', entryPoint: 'websecure' };

function build(rows: { host: string; verified: boolean }[], addresses: Record<string, string[]>, clock = () => 0) {
    let lookups = 0;
    const seam: WebSeam = {
        addresses: (name) => {
            lookups += 1;
            return Promise.resolve(addresses[name] ?? []);
        },
        handshake: () => Promise.resolve(null)
    };
    const config = createProxyConfig({ routable: () => Promise.resolve(rows) }, SETTINGS, {
        features: () => ['x-rdv'],
        publicHost: HERE,
        reserved: ['app.deveye.test', 'api.deveye.test'],
        seam,
        clock
    });
    return { config, lookups: () => lookups };
}

describe('createProxyConfig', () => {
    it('un routeur par nom, vers l’écouteur public, avec le résolveur du proxy', async () => {
        const { config } = build([{ host: 'rdv.exemple.fr', verified: true }], {});
        const out = await config();
        assert.deepEqual(out.http.routers, {
            'deveye-rdv_exemple_fr': {
                rule: 'Host(`rdv.exemple.fr`)',
                entryPoints: ['websecure'],
                service: 'deveye-domains',
                tls: { certResolver: 'letsencrypt' }
            }
        });
        assert.deepEqual(out.http.services['deveye-domains'], {
            loadBalancer: { servers: [{ url: 'http://deveye-server:3001' }] }
        });
    });

    it('un nom jamais vérifié n’entre que s’il pointe ici, un nom vérifié sans regarder', async () => {
        const { config } = build(
            [
                { host: 'pret.exemple.fr', verified: false },
                { host: 'ailleurs.exemple.fr', verified: false },
                { host: 'tenu.exemple.fr', verified: true }
            ],
            { 'pret.exemple.fr': [HERE], 'ailleurs.exemple.fr': ['198.51.100.1'], 'tenu.exemple.fr': [] }
        );
        assert.deepEqual(Object.keys((await config()).http.routers).sort(), [
            'deveye-pret_exemple_fr',
            'deveye-tenu_exemple_fr'
        ]);
    });

    it('écarte les noms de DevEye lui-même et tout ce qui n’est pas un nom d’hôte', async () => {
        const { config } = build(
            [
                { host: 'app.deveye.test', verified: true },
                { host: 'x`) || Host(`victime.fr', verified: true }
            ],
            {}
        );
        assert.deepEqual((await config()).http.routers, {});
    });

    it('garde en mémoire le verdict du DNS, plus longtemps quand le nom pointe', async () => {
        let now = 0;
        const { config, lookups } = build(
            [{ host: 'pret.exemple.fr', verified: false }],
            { 'pret.exemple.fr': [HERE] },
            () => now
        );
        await config();
        await config();
        assert.equal(lookups(), 1);
        now = 11 * 60_000;
        await config();
        assert.equal(lookups(), 2);
    });
});

describe('createProxyConfig et les pauses de l’offre', () => {
    it('passe au dépôt les lignes que l’offre tient en pause, pour qu’il les écarte', async () => {
        const seen: (readonly string[])[] = [];
        const config = createProxyConfig(
            {
                routable: (_features, pausedIds) => {
                    seen.push(pausedIds);
                    return Promise.resolve([]);
                }
            },
            SETTINGS,
            { features: () => ['x-rdv'], pausedIds: () => ['4', '9'], publicHost: HERE, reserved: [] }
        );
        await config();
        assert.deepEqual(seen, [['4', '9']]);
    });
});

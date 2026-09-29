import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeatureMaintenanceLevel } from '@deveye/types';

import { buildProbe, cachedLoader, type ProbeSources } from './statusProbe';

function sources(over: Partial<ProbeSources> = {}, levels: Record<string, FeatureMaintenanceLevel> = {}): ProbeSources {
    return {
        version: () => '1.2.3',
        pingDatabase: async () => true,
        site: () => ({ down: false, message: 'En maintenance', priority: false }),
        features: () => [
            { id: 'notes', label: 'Notes' },
            { id: 'mailserver', label: 'Serveur mail' },
            { id: 'x-hidden', label: 'Caché' }
        ],
        level: (id) => levels[id] ?? null,
        health: () => ({ state: 'up', reason: null }),
        serviceHealth: async () => null,
        ...over
    };
}

describe('buildProbe', () => {
    it('tout va bien', async () => {
        const probe = await buildProbe(sources());
        assert.equal(probe.version, '1.2.3');
        assert.equal(probe.database, true);
        assert.deepEqual(probe.site, { state: 'up', message: null });
        assert.deepEqual(
            probe.features.map((f) => f.state),
            ['up', 'up', 'up']
        );
    });

    it('la préversion est absente, la maintenance d’un module est dite', async () => {
        const probe = await buildProbe(sources({}, { 'x-hidden': 'preview', notes: 'requests' }));
        assert.deepEqual(
            probe.features.map((f) => [f.id, f.state]),
            [
                ['notes', 'maintenance'],
                ['mailserver', 'up']
            ]
        );
    });

    it('la maintenance du site porte son message, la priorité dégrade', async () => {
        const down = await buildProbe(
            sources({ site: () => ({ down: true, message: 'Retour à 14 h', priority: true }) })
        );
        assert.deepEqual(down.site, { state: 'maintenance', message: 'Retour à 14 h' });
        const held = await buildProbe(sources({ site: () => ({ down: false, message: 'x', priority: true }) }));
        assert.deepEqual(held.site, { state: 'degraded', message: null });
    });

    it('le pire de l’hôte et du module l’emporte', async () => {
        const probe = await buildProbe(
            sources({
                health: (id) =>
                    id === 'notes'
                        ? { state: 'degraded', reason: 'Erreurs à répétition' }
                        : { state: 'up', reason: null },
                serviceHealth: async (id) =>
                    id === 'mailserver' ? { state: 'down', reason: 'Serveur mail injoignable' } : { state: 'up' }
            })
        );
        const byId = Object.fromEntries(probe.features.map((f) => [f.id, f]));
        assert.deepEqual([byId.notes!.state, byId.notes!.reason], ['degraded', 'Erreurs à répétition']);
        assert.deepEqual([byId.mailserver!.state, byId.mailserver!.reason], ['down', 'Serveur mail injoignable']);
    });
});

describe('cachedLoader', () => {
    it('un seul calcul pour des appels simultanés, puis la valeur tenue jusqu’à expiration', async () => {
        let now = 0;
        let calls = 0;
        const load = cachedLoader(
            async () => ++calls,
            1000,
            () => now
        );
        assert.deepEqual(await Promise.all([load(), load()]), [1, 1]);
        now = 999;
        assert.equal(await load(), 1);
        now = 1000;
        assert.equal(await load(), 2);
    });

    it('un échec n’est pas tenu', async () => {
        let fail = true;
        const load = cachedLoader(async () => {
            if (fail) throw new Error('base');
            return 'ok';
        }, 1000);
        await assert.rejects(load());
        fail = false;
        assert.equal(await load(), 'ok');
    });
});

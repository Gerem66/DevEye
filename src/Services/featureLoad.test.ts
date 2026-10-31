import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFeatureLoad } from './featureLoad';

describe('featureLoad', () => {
    it('ne compte rien sans écoute', async () => {
        const load = createFeatureLoad();
        assert.equal(await load.time('notes', () => 42), 42);
        const watch = load.watch();
        assert.equal(watch.drain().size, 0);
    });

    it('cumule par clé, et repart de zéro à chaque lecture', async () => {
        let clock = 0;
        const load = createFeatureLoad(() => clock);
        const watch = load.watch();
        await load.time('notes', () => {
            clock += 10;
        });
        await load.time('notes', async () => {
            clock += 5;
        });
        await load.time('uptime', () => {
            clock += 1;
        });
        assert.deepEqual(Object.fromEntries(watch.drain()), {
            notes: { calls: 2, ms: 15 },
            uptime: { calls: 1, ms: 1 }
        });
        assert.equal(watch.drain().size, 0);
    });

    it('compte un échec, et le laisse passer', async () => {
        let clock = 0;
        const load = createFeatureLoad(() => clock);
        const watch = load.watch();
        await assert.rejects(
            load.time('mail', () => {
                clock += 3;
                throw new Error('boum');
            }),
            /boum/
        );
        assert.deepEqual(watch.drain().get('mail'), { calls: 1, ms: 3 });
    });

    it('se tait une fois l’écoute arrêtée, même pour une commande déjà en vol', async () => {
        const load = createFeatureLoad();
        const watch = load.watch();
        let release!: () => void;
        const pending = load.time('notes', () => new Promise<void>((r) => (release = r)));
        watch.stop();
        release();
        await pending;
        assert.equal(watch.drain().size, 0);
    });
});

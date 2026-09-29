import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_ID, createMonitor, type ComponentChange } from './monitor';
import type { ProbeResult } from './probe';
import type { Observation } from './state';
import { openStore } from './store';

const INTERVAL = 60;
const ok: Observation = { state: 'up', reason: null, message: null };

function result(
    app: Observation,
    features: ProbeResult['features'] = [
        { id: 'notes', label: 'Notes', state: 'up', reason: null },
        { id: 'mail', label: 'Mail', state: 'up', reason: null }
    ]
): ProbeResult {
    return { app, public: null, features, version: '1.0.0', refused: false };
}

function setup() {
    const store = openStore(':memory:');
    let next: ProbeResult = result(ok);
    let clock = 1_000_000;
    const changes: ComponentChange[] = [];
    const monitor = createMonitor({
        store,
        intervalSeconds: INTERVAL,
        probe: async () => next,
        onChange: (c) => changes.push(c),
        warn: () => undefined,
        now: () => clock
    });
    return {
        store,
        changes,
        async tick(r: ProbeResult, advanceBy = INTERVAL) {
            next = r;
            await monitor.tick();
            clock += advanceBy;
        },
        at: () => clock
    };
}

describe('createMonitor', () => {
    it('compte chaque passage dans la journée de chaque composant', async () => {
        const m = setup();
        await m.tick(result(ok));
        await m.tick(result(ok));
        const day = m.store.daily(APP_ID, 0);
        assert.equal(day.length, 1);
        assert.equal(day[0]!.checks, 2);
        assert.equal(day[0]!.up, 2);
        assert.equal(m.store.daily('notes', 0)[0]!.up, 2);
    });

    it('une panne confirmée ouvre un incident sur l’app seule ; les modules la suivent sans incident', async () => {
        const m = setup();
        const down: Observation = { state: 'down', reason: 'Ne répond pas', message: null };
        await m.tick(result(ok));
        const firstFailure = m.at();
        await m.tick(result(down, null));
        await m.tick(result(down, null));
        const app = m.store.component(APP_ID)!;
        assert.equal(app.state, 'down');
        assert.equal(app.since, firstFailure);
        assert.equal(m.store.component('notes')!.state, 'down');
        assert.equal(m.store.component('notes')!.inherited, true);
        const incidents = m.store.incidents([APP_ID, 'notes', 'mail'], 0);
        assert.deepEqual(
            incidents.map((i) => [i.component, i.state, i.startedAt, i.endedAt]),
            [[APP_ID, 'down', firstFailure, null]]
        );
        assert.equal(m.store.daily('notes', 0)[0]!.down, 1);
    });

    it('la maintenance s’applique aussitôt et compte comme une indisponibilité', async () => {
        const m = setup();
        await m.tick(result({ state: 'maintenance', reason: null, message: 'Retour à 14 h' }));
        const app = m.store.component(APP_ID)!;
        assert.equal(app.state, 'maintenance');
        assert.equal(app.message, 'Retour à 14 h');
        assert.equal(m.store.component('mail')!.state, 'maintenance');
        assert.equal(m.store.daily(APP_ID, 0)[0]!.maintenance, 1);
        await m.tick(result(ok));
        const [incident] = m.store.incidents([APP_ID], 0);
        assert.equal(incident!.state, 'maintenance');
        assert.notEqual(incident!.endedAt, null);
        assert.equal(m.store.component('mail')!.state, 'up');
    });

    it('la panne propre d’un module ouvre son incident', async () => {
        const m = setup();
        const broken = [{ id: 'notes', label: 'Notes', state: 'down' as const, reason: 'Serveur injoignable' }];
        await m.tick(result(ok));
        await m.tick(result(ok, broken));
        await m.tick(result(ok, broken));
        assert.equal(m.store.component('notes')!.state, 'down');
        assert.equal(m.store.incidents(['notes'], 0).length, 1);
        assert.equal(m.store.component('mail')!.listed, false);
    });

    it('le temps où la page d’état était arrêtée ne compte pas contre DevEye', async () => {
        const m = setup();
        const down: Observation = { state: 'down', reason: null, message: null };
        await m.tick(result(down, null));
        const last = m.at();
        await m.tick(result(down, null), 10 * INTERVAL);
        await m.tick(result(ok));
        const [incident] = m.store.incidents([APP_ID], 0);
        assert.equal(incident!.endedAt, last + INTERVAL);
        assert.equal(m.store.component(APP_ID)!.state, 'up');
    });
});

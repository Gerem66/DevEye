import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    COMMAND_FAILURES_DEGRADED,
    COMMAND_WINDOW_MS,
    TICK_FAILURES_DEGRADED,
    createFeatureHealth
} from './featureHealth';

describe('featureHealth', () => {
    it('une tâche de fond dégrade après des échecs d’affilée, un succès la rétablit', () => {
        const health = createFeatureHealth();
        const tick = health.ticker('uptime');
        for (let i = 1; i < TICK_FAILURES_DEGRADED; i++) tick.failed();
        assert.equal(health.of('uptime').state, 'up');
        tick.failed();
        assert.deepEqual(health.of('uptime'), { state: 'degraded', reason: 'Tâches de fond en échec' });
        tick.succeeded();
        assert.equal(health.of('uptime').state, 'up');
    });

    it('les tâches d’un même module se comptent séparément', () => {
        const health = createFeatureHealth();
        const probe = health.ticker('uptime');
        const prune = health.ticker('uptime');
        for (let i = 0; i < TICK_FAILURES_DEGRADED; i++) {
            probe.failed();
            prune.succeeded();
        }
        assert.equal(health.of('uptime').state, 'degraded');
    });

    it('une tâche arrêtée ne compte plus', () => {
        const health = createFeatureHealth();
        const tick = health.ticker('git');
        for (let i = 0; i < TICK_FAILURES_DEGRADED; i++) tick.failed();
        tick.forget();
        assert.equal(health.of('git').state, 'up');
    });

    it('des commandes qui plantent dégradent, puis s’oublient avec la fenêtre', () => {
        let now = 0;
        const health = createFeatureHealth(() => now);
        for (let i = 0; i < COMMAND_FAILURES_DEGRADED; i++) health.commandFailed('notes');
        assert.deepEqual(health.of('notes'), { state: 'degraded', reason: 'Erreurs à répétition' });
        assert.equal(health.of('mail').state, 'up');
        now = COMMAND_WINDOW_MS;
        assert.equal(health.of('notes').state, 'up');
    });
});

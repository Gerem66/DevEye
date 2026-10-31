import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DebugLoadSample } from '@deveye/types';

import { analyze, saturation } from './analysis';

const sample = (
    t: number,
    users: number,
    p95: number | null,
    extra: Partial<DebugLoadSample> = {}
): DebugLoadSample => ({
    t,
    users,
    sockets: users,
    commands: 100,
    refused: 0,
    errors: 0,
    p50: p95,
    p95,
    max: p95,
    arrivals: 0,
    cpuPct: 10,
    loopP99: 0,
    rssMb: 100,
    features: {},
    ...extra
});

describe('analyse de la montée en charge', () => {
    it('attend trois seaux mesurés avant de poser une référence', () => {
        assert.deepEqual(analyze([sample(5, 0, null), sample(10, 2, 20), sample(15, 4, 22)]), {
            baselineP95: null,
            degradedAt: null
        });
    });

    it('prend la médiane des premiers p95, et ignore les seaux sans utilisateur', () => {
        const verdict = analyze([sample(5, 0, 900), sample(10, 2, 20), sample(15, 4, 30), sample(20, 6, 25)]);
        assert.equal(verdict.baselineP95, 25);
        assert.equal(verdict.degradedAt, null);
    });

    it('situe la dégradation au premier de deux seaux au-delà du seuil', () => {
        const samples = [
            sample(5, 2, 20),
            sample(10, 4, 20),
            sample(15, 6, 20),
            sample(20, 8, 400),
            sample(25, 10, 30),
            sample(30, 12, 300),
            sample(35, 14, 500)
        ];
        assert.deepEqual(analyze(samples).degradedAt, { t: 30, users: 12 });
    });

    it('exige 100 ms de plus que la référence, pas seulement le double', () => {
        const samples = [sample(5, 2, 3), sample(10, 4, 3), sample(15, 6, 3), sample(20, 8, 90), sample(25, 10, 95)];
        assert.equal(analyze(samples).degradedAt, null);
    });

    it('arrête la montée sur deux seaux saturés de suite, avec la raison', () => {
        assert.equal(saturation([sample(5, 2, 4000)]), null);
        assert.equal(saturation([sample(5, 2, 20), sample(10, 4, 4000)]), null);
        assert.equal(saturation([sample(5, 2, 3500), sample(10, 4, 4000)]), 'temps de réponse p95 au-delà de 3 s');
        assert.equal(
            saturation([sample(5, 2, 20, { errors: 6 }), sample(10, 4, 20, { errors: 9 })]),
            'plus de 5 % d’erreurs'
        );
        assert.equal(
            saturation([sample(5, 2, 20, { loopP99: 1200 }), sample(10, 4, 20, { loopP99: 1500 })]),
            'boucle d’événements en retard de plus d’1 s'
        );
    });
});

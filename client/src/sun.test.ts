import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { daylightAt, sunDay } from './sun';

const PARIS = { lat: 48.8566, lon: 2.3522 };
const REYKJAVIK = { lat: 64.1466, lon: -21.9426 };
const TROMSO = { lat: 69.6492, lon: 18.9553 };

function near(actual: number, expectedIso: string, minutes = 4): void {
    const gap = Math.abs(actual - Date.parse(expectedIso)) / 60_000;
    assert.ok(gap <= minutes, `${new Date(actual).toISOString()} au lieu de ${expectedIso}`);
}

describe('sunDay', () => {
    it('donne le lever et le coucher de Paris au solstice d’été', () => {
        const day = sunDay(Date.parse('2026-06-21T12:00:00Z'), PARIS);
        assert.ok(!('polar' in day));
        near(day.rise, '2026-06-21T03:47:00Z');
        near(day.set, '2026-06-21T19:58:00Z');
    });

    it('donne des jours de douze heures à l’équateur à l’équinoxe', () => {
        const day = sunDay(Date.parse('2026-03-20T12:00:00Z'), { lat: 0, lon: 0 });
        assert.ok(!('polar' in day));
        near(day.rise, '2026-03-20T06:04:00Z');
        near(day.set, '2026-03-20T18:11:00Z');
    });

    it('reconnaît le jour et la nuit polaires', () => {
        assert.deepEqual(sunDay(Date.parse('2026-06-21T12:00:00Z'), TROMSO), { polar: 'day' });
        assert.deepEqual(sunDay(Date.parse('2026-12-21T12:00:00Z'), TROMSO), { polar: 'night' });
    });
});

describe('daylightAt', () => {
    it('bascule au prochain coucher le jour, au prochain lever la nuit', () => {
        const noon = daylightAt(Date.parse('2026-06-21T12:00:00Z'), PARIS);
        assert.equal(noon.light, true);
        near(noon.until ?? 0, '2026-06-21T19:58:00Z');
        const night = daylightAt(Date.parse('2026-06-21T23:00:00Z'), PARIS);
        assert.equal(night.light, false);
        near(night.until ?? 0, '2026-06-22T03:47:00Z');
    });

    it('garde le jour après minuit quand le coucher de la veille n’est pas passé', () => {
        const state = daylightAt(Date.parse('2026-06-22T00:00:00Z'), REYKJAVIK);
        assert.equal(state.light, true);
        near(state.until ?? 0, '2026-06-22T00:04:00Z', 6);
    });

    it('reste clair sous le soleil de minuit, sans borne prochaine', () => {
        assert.deepEqual(daylightAt(Date.parse('2026-06-21T23:00:00Z'), TROMSO), { light: true, until: null });
    });
});

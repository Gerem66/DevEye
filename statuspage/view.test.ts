import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNKNOWN } from './state';
import { DAY, dayOf, type ComponentRow, type DailyRow } from './store';
import { PAGE_DAYS, barsOf, buildView, ratioOf, type ViewInput } from './view';

const NOW = 1_700_000_000;
const row = (over: Partial<DailyRow>): DailyRow => ({
    day: dayOf(NOW),
    checks: 0,
    up: 0,
    degraded: 0,
    down: 0,
    maintenance: 0,
    ...over
});
const component = (over: Partial<ComponentRow>): ComponentRow => ({
    ...UNKNOWN,
    id: 'deveye',
    label: 'Application DevEye',
    kind: 'app',
    position: 0,
    listed: true,
    state: 'up',
    ...over
});

function input(components: ComponentRow[], daily: DailyRow[] = []): ViewInput {
    return { now: NOW, intervalSeconds: 60, components, daily: () => daily, incidents: () => [] };
}

describe('barsOf', () => {
    it('90 barres, la pire mesure du jour donne sa couleur', () => {
        const bars = barsOf(
            [
                row({ checks: 10, up: 9, maintenance: 1 }),
                row({ day: dayOf(NOW) - DAY, checks: 10, up: 8, degraded: 1, down: 1 })
            ],
            NOW,
            60
        );
        assert.equal(bars.length, PAGE_DAYS);
        assert.equal(bars.at(-1)!.tone, 'maintenance');
        assert.equal(bars.at(-1)!.maintenanceSeconds, 60);
        assert.equal(bars.at(-2)!.tone, 'down');
        assert.equal(bars[0]!.tone, 'empty');
    });
});

describe('ratioOf', () => {
    it('la maintenance compte contre la disponibilité, la perturbation non', () => {
        assert.equal(ratioOf([row({ checks: 4, up: 2, degraded: 1, maintenance: 1 })]), 0.75);
        assert.equal(ratioOf([]), null);
    });
});

describe('buildView', () => {
    const features = [
        component({ id: 'notes', label: 'Notes', kind: 'feature', position: 10 }),
        component({ id: 'mail', label: 'Mail', kind: 'feature', position: 11, state: 'down', reason: 'Injoignable' }),
        component({ id: 'old', label: 'Retiré', kind: 'feature', position: 12, listed: false })
    ];

    it('la vue d’ensemble montre l’app et les modules touchés ; le sélecteur les liste tous', () => {
        const view = buildView(input([component({}), ...features]), null)!;
        assert.deepEqual(
            view.components.map((c) => c.id),
            ['deveye', 'mail']
        );
        assert.deepEqual(
            view.picker.map((p) => p.id),
            ['notes', 'mail']
        );
        assert.equal(view.banner.tone, 'down');
        assert.equal(view.banner.title, 'Panne en cours sur 1 service');
    });

    it('l’app en maintenance l’emporte, avec son message', () => {
        const view = buildView(
            input([component({ state: 'maintenance', message: 'Retour à 14 h' }), ...features]),
            null
        )!;
        assert.deepEqual(view.banner, {
            tone: 'maintenance',
            title: 'DevEye est en maintenance',
            detail: null,
            message: 'Retour à 14 h'
        });
    });

    it('une fonctionnalité a sa page ; une inconnue ou retirée n’en a pas', () => {
        const view = buildView(input([component({}), ...features]), 'mail')!;
        assert.equal(view.feature?.label, 'Mail');
        assert.equal(view.banner.title, '« Mail » est hors service');
        assert.equal(buildView(input([component({}), ...features]), 'old'), null);
        assert.equal(buildView(input([component({}), ...features]), 'nope'), null);
    });

    it('un module qui suit l’app le dit', () => {
        const held = component({ id: 'notes', label: 'Notes', kind: 'feature', state: 'down', inherited: true });
        const view = buildView(input([component({ state: 'down' }), held]), 'notes')!;
        assert.equal(view.banner.title, 'DevEye est hors service');
    });
});

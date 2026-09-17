import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeatureDomainRow } from '@/db/repos/featureDomains';
import { FAILURES_BEFORE_DROP, judge, verdictChanged, type DomainSeam } from './engine';

const NOW = 1_000_000;
const OWNERSHIP = { name: '_deveye.exemple.fr', value: 'deveye-rdv=jeton' };

function row(over: Partial<FeatureDomainRow> = {}): FeatureDomainRow {
    return {
        id: 1,
        workspace_id: 1,
        feature: 'x-rdv',
        host: 'exemple.fr',
        token: 'jeton',
        dns_state: 'pending',
        dns_error: '',
        probe_state: 'pending',
        probe_error: '',
        verified_at: null,
        checked_at: null,
        failures: 0,
        next_probe_at: NOW,
        created: NOW - 10,
        ...over
    };
}

function seam(over: Partial<DomainSeam> = {}): DomainSeam {
    return {
        txt: () => Promise.resolve([OWNERSHIP.value]),
        probe: () => Promise.resolve({ ok: true }),
        okSeconds: 3600,
        pendingSeconds: 600,
        ...over
    };
}

describe('judge : la propriété', () => {
    it('sans TXT, échoue sans jamais sonder le service', async () => {
        let probed = false;
        const verdict = await judge(
            row(),
            OWNERSHIP,
            NOW,
            seam({
                txt: () => Promise.resolve([]),
                probe: () => {
                    probed = true;
                    return Promise.resolve({ ok: true });
                }
            })
        );
        assert.equal(verdict.dns_state, 'failed');
        assert.equal(verdict.probe_state, 'pending');
        assert.match(verdict.dns_error, /introuvable/);
        assert.equal(verdict.next_probe_at, NOW + 600);
        assert.equal(probed, false);
    });

    it('distingue un TXT présent mais étranger', async () => {
        const verdict = await judge(row(), OWNERSHIP, NOW, seam({ txt: () => Promise.resolve(['deveye-rdv=autre']) }));
        assert.match(verdict.dns_error, /jeton attendu/);
    });

    it('trouve le jeton parmi plusieurs valeurs, espaces compris', async () => {
        const verdict = await judge(
            row(),
            OWNERSHIP,
            NOW,
            seam({ txt: () => Promise.resolve(['deveye-mailserver=x', ` ${OWNERSHIP.value} `]) })
        );
        assert.equal(verdict.dns_state, 'ok');
    });

    it('rend la panne du résolveur telle quelle', async () => {
        const verdict = await judge(row(), OWNERSHIP, NOW, seam({ txt: () => Promise.reject(new Error('ETIMEOUT')) }));
        assert.equal(verdict.dns_error, 'ETIMEOUT');
    });
});

describe('judge : le service', () => {
    it('pose verified_at au premier succès, et remet les échecs à zéro', async () => {
        const verdict = await judge(row({ failures: 2 }), OWNERSHIP, NOW, seam());
        assert.equal(verdict.verified_at, NOW);
        assert.equal(verdict.failures, 0);
        assert.equal(verdict.next_probe_at, NOW + 3600);
    });

    it('garde la date de première vérification', async () => {
        const verdict = await judge(row({ verified_at: 42 }), OWNERSHIP, NOW, seam());
        assert.equal(verdict.verified_at, 42);
    });

    it('rend la phrase de la sonde, et une sonde qui lève vaut un échec', async () => {
        const said = await judge(
            row(),
            OWNERSHIP,
            NOW,
            seam({ probe: () => Promise.resolve({ ok: false, error: 'MX absent' }) })
        );
        assert.equal(said.probe_state, 'failed');
        assert.equal(said.probe_error, 'MX absent');
        const thrown = await judge(row(), OWNERSHIP, NOW, seam({ probe: () => Promise.reject(new Error('boom')) }));
        assert.equal(thrown.probe_error, 'boom');
    });
});

describe('judge : un domaine vérifié ne retombe qu’au troisième échec', () => {
    for (const [stage, broken] of [
        ['propriété', seam({ txt: () => Promise.resolve([]) })],
        ['service', seam({ probe: () => Promise.resolve({ ok: false, error: 'non' }) })]
    ] as const) {
        it(`étage ${stage}`, async () => {
            const held = await judge(
                row({ verified_at: 42, failures: FAILURES_BEFORE_DROP - 2 }),
                OWNERSHIP,
                NOW,
                broken
            );
            assert.equal(held.verified_at, 42);
            assert.equal(held.failures, FAILURES_BEFORE_DROP - 1);
            const dropped = await judge(
                row({ verified_at: 42, failures: FAILURES_BEFORE_DROP - 1 }),
                OWNERSHIP,
                NOW,
                broken
            );
            assert.equal(dropped.verified_at, null);
        });
    }
});

describe('verdictChanged', () => {
    it('ne bat que quand un état ou la vérification bascule', async () => {
        const healthy = row({ dns_state: 'ok', probe_state: 'ok', verified_at: 42 });
        assert.equal(verdictChanged(healthy, await judge(healthy, OWNERSHIP, NOW, seam())), false);
        assert.equal(verdictChanged(row(), await judge(row(), OWNERSHIP, NOW, seam())), true);
    });
});

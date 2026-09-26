import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    OSINT_PROBE_META,
    OSINT_PROBES_BY_KIND,
    osintProbePricing,
    osintProbeUsable,
    osintProviderSchema,
    osintTargetKindSchema
} from '../../contracts/domain';

import { parseKeyIndex } from './pgp';
import { nameSplits } from './registry';
import { coversName, nameTokens, PROBES, probesFor } from '.';

describe('le registre des sondes', () => {
    it('sert chaque sonde que la table partagée annonce', () => {
        // `probesFor` écarte en silence une sonde qui refuse sa nature : sans
        // ce test, une carte promise au client disparaîtrait sans bruit.
        for (const kind of osintTargetKindSchema.options) {
            assert.deepEqual(probesFor(kind), OSINT_PROBES_BY_KIND[kind], kind);
        }
    });

    it('range chaque sonde sous son identifiant', () => {
        for (const [id, probe] of Object.entries(PROBES)) assert.equal(probe.id, id);
    });

    it('donne un usage à chaque clé que les réglages proposent', () => {
        // Une clé qu'on peut poser sans qu'aucune sonde la lise est une promesse
        // que l'écran ne tient pas.
        const used = new Set(Object.values(OSINT_PROBE_META).map((m) => m.key?.provider));
        for (const provider of osintProviderSchema.options) assert.ok(used.has(provider), provider);
    });

    it('ne rend indisponible que ce qui exige une clé absente', () => {
        const none = new Set<never>();
        assert.equal(osintProbeUsable('breaches', none), false);
        assert.equal(osintProbeUsable('breaches', new Set(['hibp'] as const)), true);
        assert.equal(osintProbeUsable('registry', none), true);
        assert.equal(osintProbeUsable('dns', none), true);
    });

    it('tarife une sonde par sa clé, une clé facultative gardant l’usage gratuit', () => {
        assert.equal(osintProbePricing('dns'), 'free');
        assert.equal(osintProbePricing('github'), 'free');
        assert.equal(osintProbePricing('registry'), 'freemium');
        assert.equal(osintProbePricing('breaches'), 'paid');
    });
});

describe('les noms', () => {
    it('compare sans accents, casse ni ordre', () => {
        assert.deepEqual(nameTokens('Hélène DE LA TOUR-MARTIN'), ['helene', 'de', 'la', 'tour', 'martin']);
        assert.ok(coversName(nameTokens('Jean Dupont'), 'DUPONT (DUPONT) JEAN MARIE'));
        assert.ok(!coversName(nameTokens('Jean Dupont'), 'Jean Dupond'));
        assert.ok(!coversName([], 'Jean Dupont'));
    });

    it('essaie les deux ordres et les prénoms composés', () => {
        assert.deepEqual(nameSplits('Jean Dupont'), [
            { first: 'Jean', last: 'Dupont' },
            { first: 'Dupont', last: 'Jean' }
        ]);
        const three = nameSplits('Jean Pierre Dupont');
        assert.ok(three.some((s) => s.first === 'Jean Pierre' && s.last === 'Dupont'));
        assert.ok(three.some((s) => s.first === 'Jean' && s.last === 'Pierre Dupont'));
        assert.ok(three.some((s) => s.first === 'Pierre Dupont' && s.last === 'Jean'));
        assert.deepEqual(nameSplits('Dupont'), []);
    });
});

describe('les clés PGP', () => {
    it('lit l’index HKP, uids échappés ou non', () => {
        const keys = parseKeyIndex(
            [
                'info:1:2',
                'pub:6AFDDB6B447170715E61ADE5E40F771F68294F39:19:1027:1711673453::',
                'uid:Jean Dupont <jean@example.org>:1711673453::',
                'pub:C9148B36669E736DC80825A138EF85E19154A3DB:22:263:1731120454::r',
                'uid:Ada%20Lovelace%20%3Cada@example.org%3E:1731120512::'
            ].join('\n')
        );
        assert.equal(keys.length, 2);
        assert.deepEqual(keys[0].uids, ['Jean Dupont <jean@example.org>']);
        assert.equal(keys[0].revoked, false);
        assert.deepEqual(keys[1].uids, ['Ada Lovelace <ada@example.org>']);
        assert.equal(keys[1].revoked, true);
    });
});

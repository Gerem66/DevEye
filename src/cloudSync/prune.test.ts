import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { snapshotsToDrop } from './prune';

const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

/** Un snapshot `auto` vieux de `ageDays` jours. */
const auto = (id: number, ageDays: number, kind = 'auto') => ({
    id,
    kind,
    created: NOW - Math.round(ageDays * DAY)
});

describe('snapshotsToDrop — rétention grand-père/père/fils', () => {
    it('garde absolument tout sur les 48 premières heures', () => {
        const snaps = [auto(1, 0.1), auto(2, 0.5), auto(3, 1), auto(4, 1.9)];
        assert.deepEqual(snapshotsToDrop(snaps, NOW, 90), []);
    });

    it('ne garde qu’un snapshot par jour entre 2 et 30 jours', () => {
        // Quatre photos du même jour (age ~10 j) : une seule survit.
        const sameDay = 10 * DAY;
        const snaps = [
            { id: 1, kind: 'auto', created: NOW - sameDay },
            { id: 2, kind: 'auto', created: NOW - sameDay - 3600 },
            { id: 3, kind: 'auto', created: NOW - sameDay - 7200 },
            { id: 4, kind: 'auto', created: NOW - sameDay - 10800 }
        ];
        const dropped = snapshotsToDrop(snaps, NOW, 90);
        assert.equal(dropped.length, 3);
        assert.ok(!dropped.includes(1), 'le plus récent du jour est conservé');
    });

    it('purge tout ce qui dépasse la limite du partage, quelle que soit l’origine', () => {
        const snaps = [auto(1, 100), auto(2, 100, 'manual'), auto(3, 100, 'preRestore')];
        assert.deepEqual(snapshotsToDrop(snaps, NOW, 90).sort(), [1, 2, 3]);
    });

    it('ne purge jamais par l’âge un snapshot manuel ou d’avant-restauration', () => {
        // Ils ont été demandés, ou servent de bouton « annuler » : seule la
        // limite absolue du partage peut les emporter.
        const snaps = [auto(1, 20, 'manual'), auto(2, 20, 'preRestore'), auto(3, 20), auto(4, 20)];
        const dropped = snapshotsToDrop(snaps, NOW, 90);
        assert.ok(!dropped.includes(1));
        assert.ok(!dropped.includes(2));
        assert.equal(dropped.length, 1, 'seul le doublon `auto` du jour saute');
    });
});

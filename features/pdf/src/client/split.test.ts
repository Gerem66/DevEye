import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addSource, EMPTY_PLAN, insertBlank, type SourceInfo } from './model';
import { splitParts } from './split';

const source = (id: string, name: string, pages: number): SourceInfo => ({
    id,
    name,
    bytes: 1,
    pages: Array.from({ length: pages }, () => ({ view: [0, 0, 400, 600] as const, rotate: 0 })),
    protectedByPassword: false,
    hasForm: false,
    pureXfa: false,
    color: 0,
    meta: { title: '', author: '', subject: '' }
});

describe('découpage', () => {
    let plan = addSource(addSource(EMPTY_PLAN, source('a', 'devis.pdf', 3)), source('b', 'contrat.pdf', 2));
    plan = insertBlank(plan, plan.pages[2].id).plan; // une blanche après la dernière page de devis

    it('par fichier, la page blanche suivant sa voisine', () => {
        const parts = splitParts(plan, { kind: 'files' });
        assert.deepEqual(
            parts?.map((p) => [p.label, p.pages.length, p.offset]),
            [
                ['devis', 4, 0],
                ['contrat', 2, 4]
            ]
        );
    });

    it('toutes les N pages', () => {
        const parts = splitParts(plan, { kind: 'every', count: 4 });
        assert.deepEqual(
            parts?.map((p) => [p.label, p.pages.length, p.offset]),
            [
                ['pages 1-4', 4, 0],
                ['pages 5-6', 2, 4]
            ]
        );
        assert.equal(splitParts(plan, { kind: 'every', count: 0 }), null);
    });

    it('selon des plages, séparées par des points-virgules', () => {
        const parts = splitParts(plan, { kind: 'ranges', text: '1-2 ; 5-' });
        assert.deepEqual(
            parts?.map((p) => [p.label, p.pages.length, p.offset]),
            [
                ['1-2', 2, 0],
                ['5-', 2, 4]
            ]
        );
        assert.equal(splitParts(plan, { kind: 'ranges', text: '1-9' }), null);
        assert.equal(splitParts(plan, { kind: 'ranges', text: '' }), null);
        assert.equal(splitParts(EMPTY_PLAN, { kind: 'files' }), null);
    });
});

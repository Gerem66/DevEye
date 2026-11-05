import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SceneElement } from '../../contracts/domain';
import { ordered, pruneTombstones, sizeOf, wins } from './merge';

const el = (id: string, over: Partial<SceneElement> = {}): SceneElement => ({
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: 10,
    isDeleted: false,
    index: 'a0',
    updated: 0,
    ...over
});

describe('wins', () => {
    it('la version la plus haute l’emporte, à égalité le plus petit nonce', () => {
        assert.equal(wins(el('a', { version: 2 }), el('a', { version: 1 })), true);
        assert.equal(wins(el('a', { version: 1 }), el('a', { version: 2 })), false);
        assert.equal(wins(el('a', { versionNonce: 5 }), el('a', { versionNonce: 9 })), true);
        assert.equal(wins(el('a', { versionNonce: 9 }), el('a', { versionNonce: 5 })), false);
        assert.equal(wins(el('a'), undefined), true);
    });

    it('le même élément ne change rien', () => {
        assert.equal(wins(el('a'), el('a')), false);
    });
});

describe('ordered', () => {
    it('trie par indice, ceux sans indice après, dans l’ordre d’arrivée', () => {
        const list = ordered([
            el('c', { index: null }),
            el('b', { index: 'a2' }),
            el('a', { index: 'a1' }),
            el('d', { index: null })
        ]);
        assert.deepEqual(
            list.map((e) => e.id),
            ['a', 'b', 'c', 'd']
        );
    });
});

describe('pruneTombstones', () => {
    it('retire les supprimés de plus d’un jour et rend leurs octets', () => {
        const now = 10 * 86_400_000;
        const old = el('old', { isDeleted: true, updated: now - 2 * 86_400_000 });
        const recent = el('recent', { isDeleted: true, updated: now - 1000 });
        const live = el('live', { updated: 0 });
        const elements = new Map([old, recent, live].map((e) => [e.id, e]));
        const sizes = new Map([old, recent, live].map((e) => [e.id, sizeOf(e)]));
        const freed = pruneTombstones(elements, sizes, now);
        assert.equal(freed, sizeOf(old));
        assert.deepEqual([...elements.keys()], ['recent', 'live']);
        assert.equal(sizes.has('old'), false);
    });
});

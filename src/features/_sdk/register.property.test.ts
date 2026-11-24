import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { parseFormFields } from './register';

/** Le corps d'un formulaire posté sur une page publique : écrit par n'importe qui, lu avant tout module. */

const name = fc.oneof(
    fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty', '', ' ', 'a[]', 'a.b'),
    fc.string({ maxLength: 8 })
);

function assertFields(fields: Record<string, string | string[]>): void {
    assert.equal(Object.getPrototypeOf(fields), null);
    const entries = Object.entries(fields);
    assert.ok(entries.length <= 64);
    for (const [, value] of entries) {
        if (Array.isArray(value)) assert.ok(value.length >= 2 && value.every((item) => typeof item === 'string'));
        else assert.equal(typeof value, 'string');
    }
}

describe('parseFormFields, sur un corps quelconque', () => {
    it('rend undefined ou soixante-quatre champs au plus, sans lever', () => {
        const body = fc.oneof(
            fc.string({ maxLength: 200 }),
            fc
                .array(fc.oneof(name, fc.constantFrom('&', '=', '%', '%zz', '%00', '+', ';', '%E0%A4%A', '\ud800')), {
                    maxLength: 300
                })
                .map((parts) => parts.join(''))
        );
        fc.assert(
            fc.property(body, (text) => {
                const fields = parseFormFields(text);
                if (fields !== undefined) assertFields(fields);
            })
        );
    });

    it('rend chaque champ qu’on y écrit, dans l’ordre de ses valeurs, quel que soit son nom', () => {
        const pairs = fc.array(fc.tuple(name, fc.string({ unit: 'grapheme', maxLength: 12 })), { maxLength: 80 });
        fc.assert(
            fc.property(pairs, (drawn) => {
                const expected = new Map<string, string[]>();
                for (const [key, value] of drawn) expected.set(key, [...(expected.get(key) ?? []), value]);

                const fields = parseFormFields(new URLSearchParams(drawn).toString());
                if (expected.size > 64) {
                    assert.equal(fields, undefined);
                    return;
                }
                assert.ok(fields);
                assertFields(fields);
                assert.deepEqual(
                    new Map(Object.entries(fields).map(([key, value]) => [key, [value].flat()])),
                    expected
                );
                assert.equal(typeof {}.toString, 'function');
            })
        );
    });
});

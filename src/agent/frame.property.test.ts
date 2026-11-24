import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentClientMessageSchema } from '@deveye/types';
import fc from 'fast-check';

import { arbitraryOf } from '../../scripts/lib/zod-arbitrary';
import { readAgentFrame } from './frame';

/**
 * Un agent tourne sur la machine d'un membre, pas sur la nôtre : ce qu'il
 * envoie n'a aucune raison d'être bien formé. Les trames valides sont tirées
 * du schéma lui-même, donc une commande ajoutée au protocole est couverte sans
 * rien écrire ici.
 */

const wire = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) ?? 'null');

/** Greffe `piece` au bout d'un chemin tiré au hasard dans une valeur JSON. */
function graft(value: unknown, path: readonly number[], piece: unknown): unknown {
    if (path.length === 0 || value === null || typeof value !== 'object') return piece;
    const keys = Object.keys(value);
    if (keys.length === 0) return piece;
    const key = keys[path[0] % keys.length];
    const copy = (Array.isArray(value) ? [...value] : { ...value }) as Record<string, unknown>;
    copy[key] = graft(copy[key], path.slice(1), piece);
    return copy;
}

const piece = fc.oneof(
    fc.jsonValue(),
    fc.constantFrom<unknown>(undefined, null, '', -1, 0.5, 2 ** 53, 1e308, [], {}, 'x'.repeat(70_000), '__proto__', {
        __proto__: null,
        constructor: 1
    })
);

function assertRead(raw: Buffer): void {
    const frame = readAgentFrame(raw);
    if (!frame.ok) {
        assert.ok(frame.reason === 'json' || frame.reason === 'schema');
        // Le refus part au journal sous cette forme.
        if (frame.reason === 'schema') assert.equal(typeof frame.error.flatten(), 'object');
        return;
    }
    const again = readAgentFrame(wire(frame.message));
    assert.ok(again.ok);
    assert.deepEqual(again.message, frame.message);
}

describe('readAgentFrame', () => {
    it('chaque commande du protocole se tire en trames que le schéma accepte', () => {
        for (const option of agentClientMessageSchema.options) {
            for (const frame of fc.sample(arbitraryOf(option), 25)) {
                const read = readAgentFrame(wire(frame));
                assert.ok(read.ok, `${option.shape.command.value} : ${JSON.stringify(frame).slice(0, 300)}`);
            }
        }
    });

    it('une trame valide se relit telle quelle, valeurs par défaut comprises', () => {
        fc.assert(
            fc.property(arbitraryOf(agentClientMessageSchema), (frame) => {
                assert.ok(readAgentFrame(wire(frame)).ok);
                assertRead(wire(frame));
            })
        );
    });

    it('une trame dont un champ est remplacé est acceptée ou refusée, sans lever', () => {
        fc.assert(
            fc.property(
                arbitraryOf(agentClientMessageSchema),
                fc.array(fc.tuple(fc.array(fc.nat(), { maxLength: 5 }), piece), { minLength: 1, maxLength: 3 }),
                (frame, grafts) => {
                    assertRead(wire(grafts.reduce((value, [path, part]) => graft(value, path, part), frame)));
                }
            )
        );
    });

    it('une trame coupée ou salie en route est refusée, sans lever', () => {
        fc.assert(
            fc.property(
                arbitraryOf(agentClientMessageSchema),
                fc.nat(),
                fc.uint8Array({ maxLength: 6 }),
                fc.boolean(),
                (frame, at, dirt, cut) => {
                    const clean = wire(frame);
                    const index = at % (clean.length + 1);
                    assertRead(
                        Buffer.concat([clean.subarray(0, index), dirt, cut ? Buffer.alloc(0) : clean.subarray(index)])
                    );
                }
            )
        );
    });

    it('des octets quelconques sont refusés, sans lever', () => {
        const deep = fc.integer({ min: 1, max: 200_000 }).map((depth) => '['.repeat(depth) + ']'.repeat(depth));
        const bytes = fc.oneof(
            fc.uint8Array({ maxLength: 200 }).map((raw) => Buffer.from(raw)),
            fc.json().map((text) => Buffer.from(text)),
            fc
                .oneof(
                    deep,
                    deep.map((nest) => `{"command":"agent.hello","payload":${nest}}`)
                )
                .map((text) => Buffer.from(text))
        );
        fc.assert(fc.property(bytes, assertRead));
    });
});

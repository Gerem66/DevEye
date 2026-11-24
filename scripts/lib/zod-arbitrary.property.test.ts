import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { z } from 'zod';

import { arbitraryOf } from './zod-arbitrary';

describe('arbitraryOf', () => {
    const schema = z.object({
        id: z.uuid(),
        name: z.string().min(1).max(8),
        digest: z.string().length(4),
        hex: z.string().regex(/^[a-f0-9]{8}$/),
        count: z.number().int().positive().max(9),
        ratio: z.number().min(0).max(1),
        kind: z.enum(['a', 'b']),
        tags: z.array(z.string().max(4)).min(1).max(3),
        note: z.string().nullable().default(null),
        extra: z.record(z.string().max(3), z.boolean()).optional(),
        shape: z.discriminatedUnion('type', [
            z.object({ type: z.literal('dot') }),
            z.object({ type: z.literal('box'), side: z.number().nonnegative() })
        ]),
        list: z.preprocess((value) => value, z.array(z.number().int()).max(2)).catch([])
    });

    it('ne tire que des valeurs que le schéma accepte, et qui survivent au JSON', () => {
        fc.assert(
            fc.property(arbitraryOf(schema), (value) => {
                const sent: unknown = JSON.parse(JSON.stringify(value));
                const verdict = schema.safeParse(sent);
                assert.ok(verdict.success, JSON.stringify(value));
            })
        );
    });

    it('tire les deux branches d’une union et l’absence d’un champ facultatif', () => {
        const drawn = fc.sample(arbitraryOf(schema), 200) as z.input<typeof schema>[];
        assert.ok(drawn.some((value) => value.shape.type === 'dot'));
        assert.ok(drawn.some((value) => value.shape.type === 'box'));
        assert.ok(drawn.some((value) => value.extra === undefined));
        assert.ok(drawn.some((value) => value.extra !== undefined));
        assert.ok(drawn.some((value) => value.note === null));
    });

    it('refuse de tirer ce qu’il ne sait pas lire, au lieu de tirer à côté', () => {
        assert.throws(() => arbitraryOf(z.string().refine((value) => value.length % 2 === 0)), /non couverte/);
        assert.throws(() => arbitraryOf(z.url()), /non couvert/);
        assert.throws(() => arbitraryOf(z.number().multipleOf(5)), /non couverte/);
        assert.throws(() => arbitraryOf(z.bigint()), /non couvert/);
        assert.throws(() => arbitraryOf(z.string().regex(/^a$/).min(5)), /trop peu/);
    });
});

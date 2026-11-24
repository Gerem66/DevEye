import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calendarDaySchema } from '@deveye/types/sdk';
import fc from 'fast-check';

/** Un contrat qui accepte un jour l'envoie à une colonne `DATE` : il ne doit accepter que ce qu'elle garde. */

const schema = calendarDaySchema();

/** Ce que MySQL garde dans un `DATE` : un jour du calendrier, de l'an 1000 à l'an 9999. */
function storable(text: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text < '1000') return false;
    const at = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === text;
}

describe('calendarDaySchema', () => {
    it('accepte un texte si, et seulement si, une colonne DATE le garderait', () => {
        const text = fc.oneof(
            fc.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            fc.stringMatching(/^(19|20|09|99)\d{2}-(0[0-9]|1[0-3])-(0[0-9]|[12][0-9]|3[0-2])$/),
            fc.stringMatching(/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/),
            fc.string({ maxLength: 12 })
        );
        fc.assert(
            fc.property(text, (value) => {
                assert.equal(schema.safeParse(value).success, storable(value), value);
            })
        );
    });

    it('accepte chaque jour du calendrier, écrit AAAA-MM-JJ', () => {
        const day = fc.date({
            min: new Date('1000-01-01T00:00:00Z'),
            max: new Date('9999-12-31T00:00:00Z'),
            noInvalidDate: true
        });
        fc.assert(
            fc.property(day, (at) => {
                assert.equal(schema.safeParse(at.toISOString().slice(0, 10)).success, true);
            })
        );
    });
});

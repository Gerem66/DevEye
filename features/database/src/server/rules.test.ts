import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DatabaseCondition, DatabaseRows } from '../contracts/domain';

import { compare, isFiring, renderMessage, runConditions, type ConditionOutcome } from './rules';

/**
 * L'évaluation d'une alerte, en fonctions pures.
 *
 * Ce qui mérite d'être tenu, c'est ce qui ne lève nulle part quand ça se
 * dérègle : une condition **qui n'a pas pu être mesurée ne franchit pas**
 * (en `and` elle empêche, en `or` elle n'entraîne pas), une condition en échec
 * n'interrompt pas les autres, et le message substitue les mesures par leur
 * nom court sans toucher à ce qu'il ne connaît pas.
 */

function condition(over: Partial<DatabaseCondition> = {}): DatabaseCondition {
    return { sql: 'SELECT 1', comparator: 'gt', threshold: 5, label: 'n', ...over };
}

describe('compare', () => {
    it('applique chaque comparateur, bornes comprises', () => {
        assert.equal(compare(6, 'gt', 5), true);
        assert.equal(compare(5, 'gt', 5), false);
        assert.equal(compare(5, 'gte', 5), true);
        assert.equal(compare(4, 'lt', 5), true);
        assert.equal(compare(5, 'lt', 5), false);
        assert.equal(compare(5, 'lte', 5), true);
        assert.equal(compare(5, 'eq', 5), true);
        assert.equal(compare(5, 'ne', 5), false);
        assert.equal(compare(4, 'ne', 5), true);
    });
});

describe('isFiring', () => {
    const measured: ConditionOutcome = { value: 10, error: null };
    const failed: ConditionOutcome = { value: null, error: 'La requête a rendu une valeur nulle.' };

    it("une condition en échec ne franchit pas : elle empêche un `and` et n'entraîne pas un `or`", () => {
        const conditions = [condition(), condition({ label: 'm' })];
        assert.equal(isFiring(conditions, [measured, failed], 'and'), false);
        assert.equal(isFiring(conditions, [failed, failed], 'or'), false);
        // La condition mesurée, elle, franchit : c'est elle qui décide en `or`.
        assert.equal(isFiring(conditions, [measured, failed], 'or'), true);
        assert.equal(isFiring(conditions, [measured, measured], 'and'), true);
    });

    it('une issue manquante vaut une condition non mesurée', () => {
        assert.equal(isFiring([condition(), condition()], [measured], 'and'), false);
    });
});

describe('runConditions', () => {
    it("mesure chaque condition, et une condition cassée n'arrête pas les autres", async () => {
        const answers: Record<string, () => DatabaseRows> = {
            'SELECT COUNT(*) FROM t': () => ({ columns: ['n'], rows: [['12']], total: null, elapsedMs: 1 }),
            'SELECT nope': () => {
                throw new Error('Unknown column');
            },
            'SELECT a, b FROM t': () => ({ columns: ['a', 'b'], rows: [['1', '2']], total: null, elapsedMs: 1 })
        };
        const session = { query: async (sql: string) => answers[sql]() };
        const out = await runConditions(session, [
            condition({ sql: 'SELECT COUNT(*) FROM t' }),
            condition({ sql: 'SELECT nope' }),
            condition({ sql: 'SELECT a, b FROM t' })
        ]);
        assert.deepEqual(
            out.map((o) => o.value),
            [12, null, null]
        );
        assert.equal(out[0].error, null);
        assert.match(out[1].error ?? '', /Unknown column/);
        // Deux colonnes ne font pas un nombre : l'échec est expliqué, pas un NaN.
        assert.match(out[2].error ?? '', /2 colonnes/);
    });
});

describe('renderMessage', () => {
    it('remplace `{label}` par la mesure, laisse les noms inconnus, et marque une mesure absente', () => {
        const conditions = [condition({ label: 'erreurs' }), condition({ label: 'lenteurs' })];
        const outcomes: ConditionOutcome[] = [
            { value: 42, error: null },
            { value: null, error: 'x' }
        ];
        assert.equal(
            renderMessage('Déjà {erreurs} erreurs, {lenteurs} lenteurs, {inconnu} ?', conditions, outcomes),
            'Déjà 42 erreurs, \u2014 lenteurs, {inconnu} ?'
        );
    });
});

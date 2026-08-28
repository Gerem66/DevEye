import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DatabaseRows } from '../contracts/domain';

import { assertReadOnly, assertSingleStatement, singleNumber } from './engine';

/**
 * Les deux gardes d'instruction et la lecture d'un nombre : ce qui sépare une
 * condition d'alerte d'un client SQL, et un seuil comparable d'un `NaN`.
 */

function rows(columns: string[], values: (string | null)[][]): DatabaseRows {
    return { columns, rows: values, total: null, elapsedMs: 0 };
}

describe('assertReadOnly', () => {
    it('accepte une lecture unique, point-virgule final compris', () => {
        for (const sql of [
            'SELECT 1',
            'select 1;',
            'WITH t AS (SELECT 1) SELECT * FROM t',
            'SHOW TABLES',
            'EXPLAIN SELECT 1'
        ]) {
            assert.doesNotThrow(() => assertReadOnly(sql), sql);
        }
    });

    it('refuse une écriture, une salve et une requête vide', () => {
        assert.throws(() => assertReadOnly('UPDATE t SET a = 1'), /lecture/);
        assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE t'), /point-virgule/);
        assert.throws(() => assertReadOnly('   '), /vide/);
    });
});

describe('assertSingleStatement', () => {
    it("accepte une écriture, mais refuse la salve et l'instruction vide", () => {
        assert.doesNotThrow(() => assertSingleStatement('UPDATE t SET a = 1;'));
        assert.throws(() => assertSingleStatement('UPDATE t SET a = 1; DELETE FROM t'), /point-virgule/);
        assert.throws(() => assertSingleStatement(''), /vide/);
    });
});

describe('singleNumber', () => {
    it('rend le nombre d’une ligne à une colonne, même transporté en chaîne', () => {
        assert.equal(singleNumber(rows(['n'], [['12']])), 12);
        assert.equal(singleNumber(rows(['n'], [['3.5']])), 3.5);
    });

    it('explique chaque forme qui ne fait pas un nombre', () => {
        assert.throws(() => singleNumber(rows(['n'], [])), /aucune ligne/);
        assert.throws(() => singleNumber(rows(['n'], [['1'], ['2']])), /2 lignes/);
        assert.throws(() => singleNumber(rows(['a', 'b'], [['1', '2']])), /2 colonnes/);
        assert.throws(() => singleNumber(rows(['n'], [[null]])), /nulle/);
        assert.throws(() => singleNumber(rows(['n'], [['douze']])), /n’est pas un nombre/);
    });
});

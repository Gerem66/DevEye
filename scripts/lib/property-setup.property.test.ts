import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';

test('le préchargement règle fast-check dans le processus de chaque fichier de propriétés', () => {
    const { seed, numRuns } = fc.readConfigureGlobal();
    assert.equal(seed, Number(process.env.FUZZ_SEED ?? 20261124));
    assert.equal(numRuns, Number(process.env.FUZZ_RUNS ?? 100));

    let runs = 0;
    fc.assert(fc.property(fc.nat(), () => void runs++));
    assert.equal(runs, numRuns);
});

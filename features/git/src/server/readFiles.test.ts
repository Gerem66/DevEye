import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickTreeFiles } from './readFiles';

/** Le tri de l'arbre avant toute lecture : ce qui part chez GitHub, et ce qui est écarté. */

const tree = [
    { path: 'package-lock.json', sha: 'a', size: 10 },
    { path: 'client/package-lock.json', sha: 'b', size: 10 },
    { path: 'README.md', sha: 'c', size: 10 },
    { path: 'big/package-lock.json', sha: 'd', size: 50_000_000 }
];
const wants = (path: string): boolean => path.endsWith('package-lock.json');

describe('pickTreeFiles', () => {
    it('garde les fichiers voulus, dans l’ordre des chemins, et écarte les trop gros', () => {
        const picked = pickTreeFiles(tree, { wants, maxFiles: 10, maxFileBytes: 1_000_000 });
        assert.deepEqual(
            picked.files.map((f) => f.path),
            ['client/package-lock.json', 'package-lock.json']
        );
        assert.deepEqual(picked.skipped, ['big/package-lock.json']);
        assert.equal(picked.truncated, false);
    });

    it('dit qu’il en reste quand le plafond de fichiers est atteint', () => {
        const picked = pickTreeFiles(tree, { wants, maxFiles: 1, maxFileBytes: 1_000_000 });
        assert.equal(picked.files.length, 1);
        assert.equal(picked.truncated, true);
    });
});

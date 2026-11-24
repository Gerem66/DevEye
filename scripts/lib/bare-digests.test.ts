import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { bareDigestProblems, bareDigestsOf, digestRoots, type DigestRoot } from './bare-digests';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-digests-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** Un module d'essai : ses fichiers, et sa déclaration si on lui en donne une. */
function moduleOf(label: string, files: Record<string, string>, declared?: unknown): DigestRoot {
    const dir = path.join(base, label);
    for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), source);
    }
    const file = path.join(dir, 'deveye-digests.json');
    if (declared !== undefined)
        fs.writeFileSync(file, typeof declared === 'string' ? declared : JSON.stringify(declared));
    return { label, dir, scan: ['src'], file };
}

const NODE =
    "import { createHash } from 'node:crypto';\nexport const ref = (v: string) => createHash('sha256').update(v).digest('hex');\n";
const REASON = 'Le condensé d’un jeton tiré au sort.';

describe('la garde des condensés sans clé', () => {
    it('voit createHash, crypto.hash et subtle.digest, mais ni les tests ni un condensé à clé', () => {
        const root = moduleOf('seen', {
            'src/server/refs.ts': NODE,
            'src/server/twice.ts': "crypto.createHash('sha256');\nawait crypto.subtle.digest('SHA-256', bytes);\n",
            'src/server/short.ts': "const d = crypto.hash('sha256', value);\n",
            'src/server/refs.test.ts': NODE,
            'src/server/keyed.ts': "createHmac('sha256', key).update(v);\nkeys.ref('name', workspaceId, v);\n",
            'src/server/node_modules/dep/index.ts': NODE
        });
        assert.deepEqual([...bareDigestsOf(root)].sort(), [
            ['src/server/refs.ts', 1],
            ['src/server/short.ts', 1],
            ['src/server/twice.ts', 2]
        ]);
    });

    it('refuse un condensé que rien ne déclare, même dans un module sans déclaration', () => {
        const root = moduleOf('undeclared', { 'src/server/refs.ts': NODE });
        const [problem, ...rest] = bareDigestProblems([root]);
        assert.deepEqual(rest, []);
        assert.match(
            problem,
            /^undeclared\/src\/server\/refs\.ts condense sans clé \(1 appel\) : passez par keys\.ref/
        );
        assert.match(problem, /undeclared\/deveye-digests\.json\.$/);
    });

    it('accepte ce qui est déclaré avec sa raison, au compte exact', () => {
        const allow = { 'src/server/refs.ts': { count: 1, reason: REASON } };
        assert.deepEqual(bareDigestProblems([moduleOf('declared', { 'src/server/refs.ts': NODE }, { allow })]), []);
        // Un second appel dans un fichier déjà déclaré ne passe pas sous la raison du premier.
        const grown = moduleOf('grown', { 'src/server/refs.ts': `${NODE}createHash('sha256');\n` }, { allow });
        assert.match(bareDigestProblems([grown])[0], /2 appels pour 1 déclaré/);
    });

    it('refuse une déclaration sans objet, sans raison, ou illisible', () => {
        const stale = moduleOf(
            'stale',
            { 'src/server/a.ts': 'export const a = 1;\n' },
            { allow: { 'src/server/gone.ts': { count: 1, reason: REASON } } }
        );
        assert.deepEqual(bareDigestProblems([stale]), [
            'stale/deveye-digests.json : « src/server/gone.ts » ne condense plus rien, retirez sa ligne.'
        ]);
        const bare = moduleOf('bare', { 'src/a.ts': NODE }, { allow: { 'src/a.ts': { count: 1, reason: 'ok' } } });
        assert.match(bareDigestProblems([bare])[0], /^bare\/deveye-digests\.json : allow\.src\/a\.ts\.reason /);
        const broken = moduleOf('broken', { 'src/a.ts': NODE }, '{ pas du json');
        assert.match(bareDigestProblems([broken])[0], /^broken\/deveye-digests\.json : JSON illisible/);
    });
});

describe('les condensés sans clé de ce dépôt', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const roots = digestRoots(ROOT, path.dirname(ROOT));

    it('lit le socle, son client, la copie de @deveye/types et chaque module installé', () => {
        const core = roots.find((r) => r.dir === ROOT);
        assert.ok(core);
        assert.equal(path.relative(ROOT, core.file), path.join('src', 'digests.json'));
        assert.deepEqual(core.scan, [
            'src',
            path.join('client', 'src'),
            path.join('node_modules', '@deveye', 'types', 'src')
        ]);
        assert.ok(roots.some((r) => r.dir === path.join(ROOT, 'features', 'notes')));
        // Si la copie des types n'était pas lue, sa ligne serait dite sans objet.
        assert.ok(bareDigestsOf(core).has('node_modules/@deveye/types/src/sdk/visitors.ts'));
    });

    it('sont tous déclarés, avec leur raison', () => {
        assert.deepEqual(bareDigestProblems(roots), []);
    });
});

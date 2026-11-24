import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { loadScopeFiles, rootOf, type ScopeRoot } from './scope-files';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-files-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

function root(label: string, content?: unknown): ScopeRoot {
    const dir = path.join(base, label);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'deveye-scope.json');
    if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return { label, dir, file, exempt: new Map() };
}

describe('loadScopeFiles', () => {
    it('lit les tables et range les dispenses dans leur dépôt', () => {
        const core = root('core', {
            tables: { users: { class: 'account', columns: ['id'] } },
            exempt: { 'src/db/repos/users.ts#all': { kind: 'instance', reason: 'La page Utilisateurs.' } }
        });
        const notes = root('notes');
        const { declared, problems } = loadScopeFiles([notes, core]);
        assert.deepEqual([...declared.keys()], ['users']);
        assert.deepEqual(problems, []);
        assert.deepEqual([...core.exempt.keys()], ['src/db/repos/users.ts#all']);
        assert.equal(notes.exempt.size, 0);
    });

    it('signale un fichier illisible, un fichier mal formé et une table déclarée deux fois', () => {
        const broken = root('broken', '{ pas du json');
        const wrong = root('wrong', { exempt: { 'a.ts#f': { kind: 'service' } } });
        const first = root('first', { tables: { logs: { class: 'instance', reason: 'Le journal.' } } });
        const second = root('second', { tables: { logs: { class: 'instance', reason: 'Encore.' } } });
        const { declared, problems } = loadScopeFiles([broken, wrong, first, second]);
        assert.deepEqual([...declared.keys()], ['logs']);
        assert.equal(problems.length, 3);
        assert.match(problems[0], /^broken\/deveye-scope\.json : JSON illisible/);
        assert.match(problems[1], /^wrong\/deveye-scope\.json : exempt\.a\.ts#f\.reason /);
        assert.equal(problems[2], 'second/deveye-scope.json : « logs » est déjà déclarée dans first/deveye-scope.json');
    });
});

describe('rootOf', () => {
    it('rend le dépôt le plus profond qui contient le fichier', () => {
        const core = root('app');
        const feature = { ...root('app/features/notes') };
        const roots = [feature, core];
        assert.equal(rootOf(path.join(feature.dir, 'src', 'server', 'repo.ts'), roots), feature);
        assert.equal(rootOf(path.join(core.dir, 'src', 'db', 'repos', 'users.ts'), roots), core);
        assert.equal(rootOf(path.join(base, 'elsewhere', 'x.ts'), roots), null);
        // Un dossier voisin au nom plus long n'est pas le module.
        assert.equal(rootOf(`${feature.dir}-autre/x.ts`, roots), core);
    });
});

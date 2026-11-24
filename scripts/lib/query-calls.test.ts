import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import ts from 'typescript';

import { callsBySymbol, enclosingFunction, functionSymbol, isInsertId, namedFunction, paramAt } from './query-calls';

const SOURCE = `
declare const q: { query(sql: string, params?: unknown[]): Promise<unknown[]>; execute(sql: string, params?: unknown[]): Promise<{ insertId: number }> };
declare function transaction<T>(run: () => Promise<T>): Promise<T>;

export async function top(ids: number[]) {
    await q.query('top', [1, ...ids, 2]);
}

export const arrow = async () => {
    await q.query('arrow', []);
};

export function createRepo() {
    return {
        async create(workspaceId: number) {
            const res = await q.execute('insert', [workspaceId]);
            const id = res.insertId;
            let loose = res.insertId;
            loose = workspaceId;
            const { insertId } = await q.execute('insert', [workspaceId]);
            const { insertId: renamed } = await q.execute('insert', [workspaceId]);
            return transaction(async () => {
                await q.query('create', [res.insertId, id, loose, insertId, renamed, workspaceId, (id as number)]);
            });
        },
        list: () => q.query('list')
    };
}

export function createNested() {
    const one = async (sql: string, params: unknown[]) => (await q.query(sql, params))[0] ?? null;
    return {
        folders: { findById: (id: number) => q.query('folders.findById', [id]) },
        messages: {
            findById: (id: number) => one('SELECT 1 FROM messages WHERE id = ?', [id]),
            findByRef: (ref: string) => one('SELECT 1 FROM messages WHERE ref = ?', [ref])
        }
    };
}

declare function define<T>(spec: { handler: T }): T;
export const removeFeature = define({ handler: async () => q.query('handler', []) });

void q.query('module', []);
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-calls-'));
const file = path.join(dir, 'sample.ts');
fs.writeFileSync(file, SOURCE);
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const program = ts.createProgram({ rootNames: [file], options: { noLib: true, types: [], strict: true } });
const checker = program.getTypeChecker();
const source = program.getSourceFile(file);

function findCall(match: (node: ts.CallExpression) => boolean): ts.CallExpression {
    let found: ts.CallExpression | null = null;
    const visit = (node: ts.Node): void => {
        if (!found && ts.isCallExpression(node) && match(node)) found = node;
        ts.forEachChild(node, visit);
    };
    if (source) visit(source);
    assert.ok(found, 'appel introuvable');
    return found;
}

/** L'appel `q.query('<name>', …)` de l'échantillon. */
function call(name: string): ts.CallExpression {
    let found: ts.CallExpression | null = null;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isStringLiteral(node.arguments[0] ?? node) &&
            node.arguments[0].getText() === `'${name}'`
        ) {
            if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') found = node;
        }
        ts.forEachChild(node, visit);
    };
    if (source) visit(source);
    assert.ok(found, `appel « ${name} » introuvable`);
    return found;
}

describe('enclosingFunction', () => {
    it('nomme la fonction, la constante fléchée, la méthode ou la propriété qui porte l’appel', () => {
        assert.equal(enclosingFunction(call('top')), 'top');
        assert.equal(enclosingFunction(call('arrow')), 'arrow');
        assert.equal(enclosingFunction(call('list')), 'list');
    });

    it('remonte au-delà d’une fonction passée en argument', () => {
        assert.equal(enclosingFunction(call('create')), 'create');
    });

    it('rend <module> hors de toute fonction', () => {
        assert.equal(enclosingFunction(call('module')), '<module>');
    });

    it('précède le nom des objets qui portent la fonction, jusqu’à la fonction qui les entoure', () => {
        assert.equal(enclosingFunction(call('folders.findById')), 'folders.findById');
        assert.equal(enclosingFunction(call('handler')), 'removeFeature.handler');
        assert.equal(enclosingFunction(call('create')), 'create');
    });
});

describe('une aide qui reçoit son SQL', () => {
    it('se retrouve par son symbole, avec chacun de ses appels', () => {
        const inHelper = findCall((node) => node.arguments[0]?.getText() === 'sql');
        const helper = namedFunction(inHelper);
        assert.ok(helper);
        const symbol = functionSymbol(helper, checker);
        assert.ok(symbol);
        const callers = callsBySymbol(program, dir).get(symbol) ?? [];
        assert.deepEqual(
            callers.map((c) => enclosingFunction(c)),
            ['messages.findById', 'messages.findByRef']
        );
    });
});

describe('isInsertId', () => {
    const given = (index: number): boolean => {
        const param = paramAt(call('create'), index);
        return param !== null && isInsertId(param, checker);
    };

    it('reconnaît `res.insertId`, une constante qui en est tirée et une déstructuration', () => {
        assert.deepEqual([0, 1, 3, 4, 6].map(given), [true, true, true, true, true]);
    });

    it('refuse une variable réaffectable et tout autre paramètre', () => {
        assert.equal(given(2), false);
        assert.equal(given(5), false);
    });
});

describe('paramAt', () => {
    it('rend le paramètre de ce rang, et rien après un étalement', () => {
        assert.equal(paramAt(call('top'), 0)?.getText(), '1');
        assert.equal(paramAt(call('top'), 1), null);
        assert.equal(paramAt(call('top'), 2), null);
    });

    it('ne rend rien sans tableau de paramètres, ni au-delà de sa fin', () => {
        assert.equal(paramAt(call('list'), 0), null);
        assert.equal(paramAt(call('arrow'), 0), null);
    });
});

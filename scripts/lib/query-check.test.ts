import assert from 'node:assert/strict';
import { test } from 'node:test';

import mysql from 'mysql2';
import ts from 'typescript';

import {
    columnShape,
    DynamicSql,
    enumValues,
    expandBulkValues,
    fieldShape,
    inlinePlaceholders,
    misfit,
    nullContext,
    sqlVariants,
    type PreparedColumn,
    type SchemaColumn
} from './query-check';

const { Types } = mysql;

/** Un programme d'un seul fichier : l'expression passée à `sql(…)` et les types déclarés. */
function compile(source: string): { checker: ts.TypeChecker; arg: ts.Expression; types: Map<string, ts.Type> } {
    const fileName = '/virtual/main.ts';
    const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, noLib: true };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile;
    host.getSourceFile = (name, lang) =>
        name === fileName ? ts.createSourceFile(name, source, lang, true) : original.call(host, name, lang);
    host.fileExists = (name) => name === fileName;
    const program = ts.createProgram([fileName], options, host);
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(fileName)!;
    let arg: ts.Expression | undefined;
    const types = new Map<string, ts.Type>();
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'sql') {
            arg = node.arguments[0];
        }
        if (ts.isTypeAliasDeclaration(node)) types.set(node.name.text, checker.getTypeAtLocation(node.name));
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { checker, arg: arg!, types };
}

function variants(source: string): string[] {
    const { checker, arg } = compile(`declare function sql(s: string): void;\n${source}`);
    return sqlVariants(arg, checker).sort();
}

test('sqlVariants suit les constantes, les gabarits et les ternaires', () => {
    assert.deepEqual(
        variants(`
            const COLUMNS = 'id, name';
            declare const desc: boolean;
            sql(\`SELECT \${COLUMNS} FROM t ORDER BY id \${desc ? 'DESC' : 'ASC'}\`);
        `),
        ['SELECT id, name FROM t ORDER BY id ASC', 'SELECT id, name FROM t ORDER BY id DESC']
    );
});

test('sqlVariants réduit une liste de « ? » à un seul et un nombre à 1', () => {
    assert.deepEqual(
        variants(`
            declare const ids: number[];
            declare const limit: number;
            sql(\`SELECT * FROM t WHERE id IN (\${ids.map(() => '?').join(', ')}) LIMIT \${limit}\`);
        `),
        ['SELECT * FROM t WHERE id IN (?) LIMIT 1']
    );
});

test('sqlVariants prend chaque membre d’une union de littéraux, et l’entrée choisie d’un objet constant', () => {
    assert.deepEqual(
        variants(`
            declare const sort: 'a' | 'b';
            const ORDER: { a: string; b: string } = { a: 'x ASC', b: 'y DESC' };
            sql('SELECT * FROM t ORDER BY ' + ORDER[sort]);
        `),
        ['SELECT * FROM t ORDER BY x ASC', 'SELECT * FROM t ORDER BY y DESC']
    );
});

test('sqlVariants joint un tableau de module, jamais un tableau local qu’on remplit ensuite', () => {
    assert.deepEqual(
        variants(`
            const COLUMNS = ['a', 'b'] as const;
            sql(\`INSERT INTO t (\${COLUMNS.join(', ')}) VALUES ?\`);
        `),
        ['INSERT INTO t (a, b) VALUES ?']
    );
    assert.throws(
        () =>
            variants(`
                function f(): void {
                    const where: string[] = [];
                    where.push('a = ?');
                    sql(\`SELECT * FROM t WHERE \${where.join(' AND ')}\`);
                }
            `),
        DynamicSql
    );
});

test('sqlVariants lève DynamicSql sur une chaîne construite à l’exécution', () => {
    assert.throws(() => variants(`declare const where: string;\nsql('SELECT * FROM t WHERE ' + where);`), DynamicSql);
});

test('expandBulkValues et inlinePlaceholders imitent ce que mysql2 fait des « ? »', () => {
    assert.deepEqual(expandBulkValues('INSERT INTO t (a, b, c) VALUES ?'), {
        sql: 'INSERT INTO t (a, b, c) VALUES (?, ?, ?)',
        folded: 2
    });
    assert.deepEqual(inlinePlaceholders("SELECT FLOOR(ts / ?) FROM t WHERE x = '?' AND y = ?"), {
        sql: "SELECT FLOOR(ts / 1) FROM t WHERE x = '?' AND y = 1",
        count: 2
    });
});

function column(over: Partial<PreparedColumn>): PreparedColumn {
    return { name: 'c', columnType: Types.LONG, flags: 1, characterSet: 63, orgTable: '', orgName: '', ...over };
}

const SCHEMA = new Map<string, SchemaColumn>([
    ['users.id', { nullable: false }],
    ['users.avatar', { nullable: true }],
    ['runs.status', { nullable: false, enumValues: enumValues("enum('running','passed','it''s')") }],
    ['devices.name', { nullable: false }]
]);

test('columnShape suit le schéma, les filtres et les jointures externes plutôt que le drapeau', () => {
    const plain = nullContext('SELECT u.id, (SELECT COUNT(*) FROM m WHERE m.user_id = u.id) AS n FROM users u');
    // Une sous-requête corrélée fait annoncer `u.id` nullable : le schéma le dément.
    assert.equal(
        columnShape(column({ name: 'id', flags: 0, orgTable: 'users', orgName: 'id' }), SCHEMA, plain).nullable,
        false
    );
    assert.equal(columnShape(column({ name: 'n', flags: 0 }), SCHEMA, plain).nullable, false);

    const filtered = nullContext('SELECT avatar FROM users WHERE avatar IS NOT NULL');
    const avatar = column({ name: 'avatar', columnType: Types.VAR_STRING, flags: 0, characterSet: 224 });
    assert.equal(columnShape({ ...avatar, orgTable: 'users', orgName: 'avatar' }, SCHEMA, filtered).nullable, false);

    const joined = nullContext('SELECT r.status, d.name FROM runs r LEFT JOIN devices d ON d.id = r.device_id');
    const name = column({ name: 'name', columnType: Types.VAR_STRING, flags: 0, characterSet: 224 });
    assert.equal(columnShape({ ...name, orgTable: 'devices', orgName: 'name' }, SCHEMA, joined).nullable, true);

    const empty = nullContext('SELECT SUM(size) AS total FROM files WHERE owner = ?');
    assert.equal(
        columnShape(column({ name: 'total', columnType: Types.NEWDECIMAL, flags: 0 }), SCHEMA, empty).nullable,
        true
    );
});

test('columnShape lit les DECIMAL en nombre, le binaire en Buffer et borne un ENUM filtré', () => {
    const ctx = nullContext("SELECT status FROM runs WHERE status IN ('running', 'passed')");
    assert.equal(columnShape(column({ columnType: Types.NEWDECIMAL }), SCHEMA, ctx).kind, 'number');
    assert.equal(columnShape(column({ columnType: Types.BLOB }), SCHEMA, ctx).kind, 'Buffer');
    assert.equal(columnShape(column({ columnType: Types.BLOB, characterSet: 224 }), SCHEMA, ctx).kind, 'string');
    const status = columnShape(
        column({
            name: 'status',
            columnType: Types.STRING,
            flags: 1 | 256,
            characterSet: 224,
            orgTable: 'runs',
            orgName: 'status'
        }),
        SCHEMA,
        ctx
    );
    assert.deepEqual(status.enumValues, ['running', 'passed']);
});

test('misfit accepte un resserrement et refuse un NULL non déclaré, un booléen, un ENUM incomplet', () => {
    const { checker, types } = compile(`
        type Num = number;
        type Bool = boolean;
        type Phase = 'running' | 'passed';
        type MaybeStr = string | null;
        type Flag = 0 | 1;
    `);
    const field = (name: string) => fieldShape(types.get(name)!, checker);
    const num = { name: 'n', sqlType: 'TINY', kind: 'number', nullable: false, computed: false } as const;
    assert.equal(misfit(num, field('Flag')), null);
    assert.match(misfit(num, field('Bool')) ?? '', /nombre/);
    assert.match(misfit({ ...num, nullable: true }, field('Num')) ?? '', /NULL/);

    const str = { name: 's', sqlType: 'VAR_STRING', kind: 'string', nullable: true, computed: false } as const;
    assert.equal(misfit(str, field('MaybeStr')), null);
    const phase = { ...str, sqlType: 'ENUM', nullable: false, enumValues: ['running', 'passed', 'failed'] };
    assert.match(misfit(phase, field('Phase')) ?? '', /'failed'/);
    assert.equal(misfit({ ...phase, enumValues: ['running'] }, field('Phase')), null);
});

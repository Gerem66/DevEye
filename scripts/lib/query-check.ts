import mysql from 'mysql2';
import ts from 'typescript';

import { selectColumns } from '@/db/columns';

/**
 * La logique de `check-queries`, sans base ni programme TS à elle : le texte
 * SQL tiré de l'AST, ce que mysql2 rend pour une colonne préparée, et la règle
 * qui dit si un champ du type de ligne l'accueille.
 */

/** Au-delà, l'appel passe pour dynamique : préparer des centaines de variantes ne prouve plus grand-chose. */
const MAX_VARIANTS = 32;

/** Une partie du texte SQL que l'évaluateur ne sait pas réduire à des chaînes (`null` : trop de variantes). */
export class DynamicSql extends Error {
    constructor(readonly node: ts.Node | null) {
        super('SQL dynamique');
    }
}

function cross(left: string[], right: string[], suffix = ''): string[] {
    const out = new Set<string>();
    for (const a of left) for (const b of right) out.add(`${a}${b}${suffix}`);
    if (out.size > MAX_VARIANTS) throw new DynamicSql(null);
    return [...out];
}

function unwrap(node: ts.Expression): ts.Expression {
    let n = node;
    while (
        ts.isParenthesizedExpression(n) ||
        ts.isAsExpression(n) ||
        ts.isSatisfiesExpression(n) ||
        ts.isNonNullExpression(n) ||
        ts.isTypeAssertionExpression(n)
    ) {
        n = n.expression;
    }
    return n;
}

/** Les valeurs qu'un type de chaînes ou de nombres littéraux admet, `null` s'il est plus large. */
function literalValues(type: ts.Type): string[] | null {
    const members = type.isUnion() ? type.types : [type];
    const values: string[] = [];
    for (const t of members) {
        if (t.isStringLiteral()) values.push(t.value);
        else if (t.isNumberLiteral()) values.push(String(t.value));
        else return null;
    }
    return values.length > 0 ? values : null;
}

function isNumberLike(type: ts.Type): boolean {
    const members = type.isUnion() ? type.types : [type];
    return members.every((t) => (t.flags & ts.TypeFlags.NumberLike) !== 0);
}

/** Le corps d'une fonction réduit à l'expression qu'elle rend, quand elle n'en rend qu'une. */
function returnedExpression(decl: ts.Node): ts.Expression | null {
    if (!ts.isFunctionDeclaration(decl) && !ts.isArrowFunction(decl) && !ts.isFunctionExpression(decl)) return null;
    const body = decl.body;
    if (!body) return null;
    if (!ts.isBlock(body)) return body;
    const returns = body.statements.filter(ts.isReturnStatement);
    if (body.statements.length !== 1 || returns.length !== 1 || !returns[0].expression) return null;
    return returns[0].expression;
}

function declarationOf(node: ts.Node, checker: ts.TypeChecker): ts.Declaration | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function isSelectColumns(callee: ts.Expression, checker: ts.TypeChecker): boolean {
    const decl = declarationOf(callee, checker);
    return (
        decl !== undefined &&
        ts.isFunctionDeclaration(decl) &&
        decl.name?.text === 'selectColumns' &&
        decl.getSourceFile().fileName.endsWith('/src/db/columns.ts')
    );
}

/**
 * Les textes SQL qu'une expression peut valoir : un par branche de ternaire ou
 * par membre d'une union de littéraux. Lève `DynamicSql` sur ce qui ne se
 * réduit pas (une clause construite à la main, un nom de table calculé).
 */
export function sqlVariants(expr: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Node>()): string[] {
    const node = unwrap(expr);
    if (seen.has(node)) throw new DynamicSql(node);
    seen.add(node);
    try {
        return evaluate(node, checker, seen);
    } finally {
        seen.delete(node);
    }
}

function evaluate(node: ts.Expression, checker: ts.TypeChecker, seen: Set<ts.Node>): string[] {
    const recurse = (e: ts.Expression): string[] => sqlVariants(e, checker, seen);

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isNumericLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
        let acc = [node.head.text];
        for (const span of node.templateSpans) acc = cross(acc, recurse(span.expression), span.literal.text);
        return acc;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return cross(recurse(node.left), recurse(node.right));
    }
    if (ts.isConditionalExpression(node)) {
        return [...new Set([...recurse(node.whenTrue), ...recurse(node.whenFalse)])];
    }

    const type = checker.getTypeAtLocation(node);
    const literals = literalValues(type);
    if (literals) return literals;
    if (isNumberLike(type)) return ['1'];

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        const decl = declarationOf(node, checker);
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const list = decl.parent;
            if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) return recurse(decl.initializer);
        }
        if (decl && ts.isPropertyAssignment(decl)) return recurse(decl.initializer);
        throw new DynamicSql(node);
    }

    if (ts.isElementAccessExpression(node)) {
        const object = constInitializer(node.expression, checker);
        if (object && ts.isObjectLiteralExpression(object)) {
            const key = literalValues(checker.getTypeAtLocation(node.argumentExpression));
            const values = new Set<string>();
            for (const prop of object.properties) {
                if (!ts.isPropertyAssignment(prop) || ts.isComputedPropertyName(prop.name)) throw new DynamicSql(node);
                if (key && !key.includes(prop.name.text)) continue;
                for (const v of recurse(prop.initializer)) values.add(v);
            }
            if (values.size > 0) return [...values];
        }
        throw new DynamicSql(node);
    }

    if (ts.isCallExpression(node)) return evaluateCall(node, checker, recurse);
    throw new DynamicSql(node);
}

/**
 * Le tableau littéral d'une constante de module. Un tableau local se remplit
 * d'ordinaire à coups de `push` après sa déclaration : son initialiseur ne dit
 * pas ce qu'il contiendra.
 */
function moduleArray(node: ts.Expression, checker: ts.TypeChecker): ts.Expression | null {
    const init = constInitializer(node, checker);
    if (!init || !ts.isArrayLiteralExpression(init)) return null;
    let decl: ts.Node = init;
    while (!ts.isVariableDeclaration(decl)) decl = decl.parent;
    const statement = decl.parent.parent;
    return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent) ? init : null;
}

/** L'initialiseur d'une constante (`const X = …`), `null` pour toute autre expression. */
function constInitializer(node: ts.Expression, checker: ts.TypeChecker): ts.Expression | null {
    const n = unwrap(node);
    if (!ts.isIdentifier(n)) return null;
    const decl = declarationOf(n, checker);
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return null;
    const list = decl.parent;
    return ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const ? unwrap(decl.initializer) : null;
}

function evaluateCall(
    node: ts.CallExpression,
    checker: ts.TypeChecker,
    recurse: (e: ts.Expression) => string[]
): string[] {
    const callee = unwrap(node.expression);

    if (isSelectColumns(callee, checker)) {
        const [aliasArg, specArg] = node.arguments;
        const alias = aliasArg.kind === ts.SyntaxKind.NullKeyword ? null : single(recurse(aliasArg), aliasArg);
        const spec = unwrap(specArg);
        if (!ts.isObjectLiteralExpression(spec)) throw new DynamicSql(specArg);
        const columns: Record<string, true | string> = {};
        for (const prop of spec.properties) {
            if (!ts.isPropertyAssignment(prop) || !prop.name || ts.isComputedPropertyName(prop.name)) {
                throw new DynamicSql(prop);
            }
            const value = unwrap(prop.initializer);
            columns[prop.name.text] =
                value.kind === ts.SyntaxKind.TrueKeyword ? true : single(recurse(prop.initializer), prop.initializer);
        }
        return [selectColumns(alias, columns)];
    }

    if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === 'join') {
            const separators = node.arguments[0] ? recurse(node.arguments[0]) : [','];
            const target = moduleArray(callee.expression, checker) ?? callee.expression;
            return joinVariants(arrayElements(target, recurse), separators);
        }
        if (method === 'trim' && node.arguments.length === 0) return recurse(callee.expression).map((s) => s.trim());
    }

    const decl = declarationOf(callee, checker);
    const target = decl && ts.isVariableDeclaration(decl) && decl.initializer ? unwrap(decl.initializer) : decl;
    const returned = target ? returnedExpression(target) : null;
    if (returned) return recurse(returned);
    throw new DynamicSql(node);
}

function single(values: string[], node: ts.Node): string {
    if (values.length !== 1) throw new DynamicSql(node);
    return values[0];
}

/**
 * Les éléments d'un tableau que l'on joint : un tableau littéral, ou une suite
 * de longueur inconnue (`xs.map(() => '?')`, `Array(n).fill('?')`) ramenée à
 * un seul élément, qui suffit à préparer la requête.
 */
function arrayElements(node: ts.Expression, recurse: (e: ts.Expression) => string[]): string[][] {
    const n = unwrap(node);
    if (ts.isArrayLiteralExpression(n)) {
        return n.elements.map((e) => {
            if (ts.isSpreadElement(e)) throw new DynamicSql(e);
            return recurse(e);
        });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const arg = n.arguments[0];
        if (method === 'map' && arg) {
            const fn = unwrap(arg);
            const returned = returnedExpression(fn);
            if (returned) return [recurse(returned)];
        }
        if (method === 'fill' && arg) return [recurse(arg)];
    }
    if (ts.isCallExpression(n) && n.arguments.length === 2) {
        const callee = unwrap(n.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.getText() === 'Array.from') {
            const returned = returnedExpression(unwrap(n.arguments[1]));
            if (returned) return [recurse(returned)];
        }
    }
    throw new DynamicSql(n);
}

function joinVariants(elements: string[][], separators: string[]): string[] {
    const out = new Set<string>();
    for (const sep of separators) {
        let acc = [''];
        elements.forEach((variants, i) => {
            acc = cross(
                acc,
                variants.map((v) => (i === 0 ? v : `${sep}${v}`))
            );
        });
        for (const s of acc) out.add(s);
    }
    return [...out];
}

/**
 * `INSERT INTO t (a, b) VALUES ?` avec un tableau de lignes : mysql2 développe
 * le `?` côté client, ce que le serveur ne sait pas préparer. On le remplace
 * par une ligne de la largeur de la liste de colonnes. Rend le SQL à préparer
 * et le nombre de `?` qu'il faut lire comme un seul paramètre.
 */
export function expandBulkValues(sql: string): { sql: string; folded: number } {
    const m = /\(([^()]*)\)\s*VALUES\s+\?/i.exec(sql);
    if (!m) return { sql, folded: 0 };
    const width = m[1].split(',').length;
    const row = `(${Array.from({ length: width }, () => '?').join(', ')})`;
    return { sql: sql.replace(/VALUES\s+\?/i, `VALUES ${row}`), folded: width - 1 };
}

/** Une colonne préparée, telle que mysql2 la décrit. */
export interface PreparedColumn {
    name: string;
    columnType: number;
    flags: number;
    characterSet: number;
    orgTable: string;
    orgName: string;
}

/** Ce que mysql2 rend pour une colonne, en protocole texte avec les options du pool. */
export interface ColumnShape {
    name: string;
    /** Le type MySQL, pour le message. */
    sqlType: string;
    kind: 'number' | 'string' | 'Date' | 'Buffer' | 'null' | 'opaque';
    /** Les valeurs d'un ENUM dont la table est connue. */
    enumValues?: string[];
    nullable: boolean;
    /** Calculée par la requête, et non lue telle quelle dans une table. */
    computed: boolean;
}

const NOT_NULL_FLAG = 1;
const ENUM_FLAG = 256;
const BINARY_CHARSET = 63;

const { Types } = mysql;

const TYPE_NAMES = new Map<number, string>(Object.entries(Types).map(([name, code]) => [code as number, name]));

/** Une colonne d'une table de la base, lue dans INFORMATION_SCHEMA. */
export interface SchemaColumn {
    nullable: boolean;
    enumValues?: string[];
}

/** `enum('a','b')` donne `['a', 'b']`. */
export function enumValues(columnType: string): string[] {
    const inner = columnType.slice(columnType.indexOf('(') + 1, columnType.lastIndexOf(')'));
    return (inner.match(/'(?:[^']|'')*'/g) ?? []).map((v) => v.slice(1, -1).replace(/''/g, "'"));
}

/** Ce que le texte d'une requête dit de la nullabilité de ses colonnes. */
export interface NullContext {
    /** Les tables jointes par LEFT JOIN, `null` quand un RIGHT JOIN brouille les côtés. */
    outerTables: Set<string> | null;
    /** Les colonnes filtrées par `IS NOT NULL`. */
    notNull: Set<string>;
    /** Les colonnes comparées (`=`, `IN`, `LIKE`…), ce qui écarte NULL hors d'une jointure externe. */
    compared: Set<string>;
    /** Les alias d'un agrégat nu sans GROUP BY : NULL sur un ensemble vide. */
    emptyAggregates: Set<string>;
    /** Les valeurs auxquelles la requête borne une colonne (`IN ('a', 'b')`, `= 'a'`). */
    pinned: Map<string, Set<string>>;
}

const QUOTED = /'((?:[^']|'')*)'/g;

function pinnedValues(sql: string): Map<string, Set<string>> {
    const pinned = new Map<string, Set<string>>();
    const lists =
        /(?:\b\w+\.)?`?(\w+)`?\s*(?:=\s*('(?:[^']|'')*')|\bIN\s*\(\s*('(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*)\s*\))/gi;
    for (const m of sql.matchAll(lists)) {
        const values = [...(m[2] ?? m[3]).matchAll(QUOTED)].map((v) => v[1].replace(/''/g, "'"));
        const prev = pinned.get(m[1]);
        pinned.set(m[1], new Set(prev ? values.filter((v) => prev.has(v)) : values));
    }
    return pinned;
}

export function nullContext(sql: string): NullContext {
    const names = (re: RegExp): Set<string> => new Set([...sql.matchAll(re)].map((m) => m[1]));
    return {
        outerTables: /\bRIGHT\s+(OUTER\s+)?JOIN\b/i.test(sql) ? null : names(/\bLEFT\s+(?:OUTER\s+)?JOIN\s+`?(\w+)/gi),
        notNull: names(/(?:\b\w+\.)?`?(\w+)`?\s+IS\s+NOT\s+NULL\b/gi),
        compared: names(/(?:\b\w+\.)?`?(\w+)`?\s*(?:=(?!>)|<>|!=|<(?!=>)|>|\bIN\s*\(|\bLIKE\b|\bBETWEEN\b)/gi),
        emptyAggregates: /\bGROUP\s+BY\b/i.test(sql)
            ? new Set()
            : names(/\b(?:SUM|MIN|MAX|AVG)\s*\((?:[^()]|\([^()]*\))*\)\s+AS\s+`?(\w+)/gi),
        pinned: pinnedValues(sql)
    };
}

/**
 * Les BIGINT en nombre (pas de `supportBigNumbers`), les DECIMAL aussi
 * (`decimalNumbers` du pool), les dates en `Date`, le binaire en `Buffer`. Un JSON est décodé : sa forme
 * échappe au contrôle.
 *
 * Le drapeau NOT NULL de MySQL est prudent à l'excès : toutes les colonnes
 * d'une table qu'une sous-requête corrélée référence, un `DATE_FORMAT` ou un
 * `(SELECT COUNT(*) …)` sont annoncés nullables. Une colonne de table suit donc
 * son schéma et les filtres de la requête, le drapeau ne servant que derrière
 * un LEFT JOIN ; une expression n'est tenue pour nullable que si c'est un
 * agrégat nu sans GROUP BY. Les valeurs d'un ENUM ne figurent pas dans les
 * métadonnées.
 */
export function columnShape(
    col: PreparedColumn,
    schema: ReadonlyMap<string, SchemaColumn>,
    ctx: NullContext
): ColumnShape {
    const known = schema.get(`${col.orgTable}.${col.orgName}`);
    const flagged = (col.flags & NOT_NULL_FLAG) === 0;
    let nullable = flagged && ctx.emptyAggregates.has(col.name);
    if (known) {
        const joined = ctx.outerTables === null || ctx.outerTables.has(col.orgTable);
        const filtered = ctx.notNull.has(col.orgName) || (!joined && ctx.compared.has(col.orgName));
        nullable = !filtered && (known.nullable || (joined && flagged));
    }
    const sqlType = TYPE_NAMES.get(col.columnType) ?? `type ${col.columnType}`;
    const base = { name: col.name, sqlType, nullable, computed: !known };
    switch (col.columnType) {
        case Types.TINY:
        case Types.SHORT:
        case Types.LONG:
        case Types.INT24:
        case Types.YEAR:
        case Types.LONGLONG:
        case Types.FLOAT:
        case Types.DOUBLE:
        case Types.DECIMAL:
        case Types.NEWDECIMAL:
            return { ...base, kind: 'number' };
        case Types.TIME:
            return { ...base, kind: 'string' };
        case Types.DATE:
        case Types.NEWDATE:
        case Types.DATETIME:
        case Types.TIMESTAMP:
            return { ...base, kind: 'Date' };
        case Types.NULL:
            return { ...base, kind: 'null', nullable: true };
        case Types.JSON:
        case Types.GEOMETRY:
            return { ...base, kind: 'opaque' };
        case Types.BIT:
            return { ...base, kind: 'Buffer' };
        default:
            if (col.characterSet === BINARY_CHARSET) return { ...base, kind: 'Buffer' };
            if (col.flags & ENUM_FLAG) {
                const pin = ctx.pinned.get(col.orgName);
                const values = known?.enumValues?.filter((v) => !pin || pin.has(v));
                return { ...base, sqlType: 'ENUM', kind: 'string', ...(values ? { enumValues: values } : {}) };
            }
            return { ...base, kind: 'string' };
    }
}

/** Ce qu'un champ du type de ligne accepte. */
export interface FieldShape {
    any: boolean;
    null: boolean;
    number: boolean;
    /** Une chaîne quelconque. */
    string: boolean;
    stringLiterals: Set<string>;
    Date: boolean;
    Buffer: boolean;
    /** Le texte du type, pour le message. */
    text: string;
}

export function fieldShape(type: ts.Type, checker: ts.TypeChecker): FieldShape {
    const shape: FieldShape = {
        any: false,
        null: false,
        number: false,
        string: false,
        stringLiterals: new Set(),
        Date: false,
        Buffer: false,
        text: checker.typeToString(type)
    };
    const visit = (t: ts.Type): void => {
        if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) shape.any = true;
        else if (t.flags & ts.TypeFlags.Null) shape.null = true;
        else if (t.flags & ts.TypeFlags.NumberLike) shape.number = true;
        else if (t.isStringLiteral()) shape.stringLiterals.add(t.value);
        else if (t.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
            shape.string = true;
        } else if (t.isUnion()) t.types.forEach(visit);
        else if (t.isIntersection()) t.types.forEach(visit);
        else if (t.flags & ts.TypeFlags.Object) {
            const name = t.getSymbol()?.getName();
            if (name === 'Date') shape.Date = true;
            else if (name === 'Buffer' || name === 'Uint8Array') shape.Buffer = true;
        }
    };
    visit(type);
    return shape;
}

const KIND_LABELS: Record<ColumnShape['kind'], string> = {
    number: 'un nombre',
    string: 'une chaîne',
    Date: 'une Date',
    Buffer: 'un Buffer',
    null: 'NULL',
    opaque: 'une valeur décodée'
};

/**
 * Pourquoi le champ n'accueille pas la colonne, ou `null` s'il l'accueille :
 * exactement, ou en la resserrant (une chaîne lue comme une union de
 * littéraux, un nombre lu comme `0 | 1`). Un NULL possible doit avoir sa place.
 */
export function misfit(col: ColumnShape, field: FieldShape): string | null {
    if (field.any || col.kind === 'opaque') return null;
    if (col.nullable && !field.null) {
        return `${col.computed ? 'l’expression' : 'la colonne'} peut valoir NULL (${col.sqlType}), le type ne l'admet pas`;
    }
    const what = `la base rend ${KIND_LABELS[col.kind]} (${col.sqlType})`;
    switch (col.kind) {
        case 'null':
            return null;
        case 'number':
            return field.number ? null : `${what}, le type attend ${field.text}`;
        case 'string': {
            if (field.string) return null;
            if (field.stringLiterals.size === 0) return `${what}, le type attend ${field.text}`;
            const missing = (col.enumValues ?? []).filter((v) => !field.stringLiterals.has(v));
            return missing.length === 0
                ? null
                : `l'ENUM admet ${missing.map((v) => `'${v}'`).join(', ')}, absent du type`;
        }
        case 'Date':
            return field.Date ? null : `${what}, le type attend ${field.text}`;
        case 'Buffer':
            return field.Buffer ? null : `${what}, le type attend ${field.text}`;
    }
}

/** Les `?` hors des chaînes remplacés par `1`, comme mysql2 les interpole, et leur nombre. */
export function inlinePlaceholders(sql: string): { sql: string; count: number } {
    let count = 0;
    const out = sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\?/g, (m) => {
        if (m !== '?') return m;
        count++;
        return '1';
    });
    return { sql: out, count };
}

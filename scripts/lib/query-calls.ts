import path from 'node:path';

import ts from 'typescript';

/**
 * Les appels que `check-queries` regarde : toute méthode `query` ou `execute`
 * de `Queryable` (le socle) ou de `SdkQueryable` (les modules), dans un fichier
 * dont les requêtes partent en production.
 */

const IGNORE_MARK = /check-queries:\s*ignore\b(.*)/;

/** Les interfaces dont les méthodes `query`/`execute` partent vers la base de l'instance. */
const QUERYABLES = [
    { name: 'Queryable', file: /\/DevEye\/src\/db\/pool\.ts$/ },
    { name: 'SdkQueryable', file: /\/sdk\/server\.(d\.)?ts$/ }
];

/** `chemin:ligne`, le chemin depuis `workspace`. */
export function whereOf(node: ts.Node, workspace: string): string {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${path.relative(workspace, sf.fileName)}:${line + 1}`;
}

export function loadProgram(root: string): ts.Program {
    const configPath = path.join(root, 'tsconfig.json');
    const parsed = ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (d) => {
                throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
            }
        }
    );
    if (!parsed) throw new Error(`tsconfig illisible : ${configPath}`);
    return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
}

/** Les fichiers dont les requêtes partent en production : ni tests, ni doublures, ni dépendances. */
function isChecked(program: ts.Program, sf: ts.SourceFile, workspace: string): boolean {
    const file = sf.fileName;
    return (
        !sf.isDeclarationFile &&
        !program.isSourceFileFromExternalLibrary(sf) &&
        !file.includes('/node_modules/') &&
        !/\.test\.tsx?$/.test(file) &&
        !file.endsWith('/src/db/pool.fake.ts') &&
        file.startsWith(workspace)
    );
}

function isInstanceQuery(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (callee.name.text !== 'query' && callee.name.text !== 'execute') return false;
    const decl = checker.getResolvedSignature(call)?.getDeclaration();
    if (!decl || !ts.isMethodSignature(decl) || !ts.isInterfaceDeclaration(decl.parent)) return false;
    const owner = decl.parent.name.text;
    const file = decl.getSourceFile().fileName;
    return QUERYABLES.some((q) => q.name === owner && q.file.test(file));
}

/** Chaque appel vers la base de l'instance, dans l'ordre des fichiers du programme. */
export function findQueryCalls(program: ts.Program, workspace: string): ts.CallExpression[] {
    const checker = program.getTypeChecker();
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isInstanceQuery(node, checker)) calls.push(node);
        ts.forEachChild(node, visit);
    };
    for (const sf of program.getSourceFiles()) if (isChecked(program, sf, workspace)) visit(sf);
    return calls;
}

/** La raison d'un `check-queries: ignore` posé juste avant l'appel ou l'instruction qui le porte, `null` sans marque. */
export function ignoreReason(call: ts.CallExpression): string | null {
    const text = call.getSourceFile().getFullText();
    let node: ts.Node = call;
    while (node.parent && !ts.isSourceFile(node.parent)) {
        for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
            const m = IGNORE_MARK.exec(text.slice(range.pos, range.end));
            if (m) return m[1].replace(/\*\/\s*$/, '').trim();
        }
        if (ts.isStatement(node)) break;
        node = node.parent;
    }
    return null;
}

/** Le tableau littéral des paramètres, sans ses enveloppes de type ; `null` quand ce n'en est pas un. */
export function paramArray(call: ts.CallExpression): ts.ArrayLiteralExpression | null {
    const arg = call.arguments[1];
    if (!arg) return null;
    let n = arg;
    while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    return ts.isArrayLiteralExpression(n) ? n : null;
}

/** Le nombre de paramètres passés, quand c'est un tableau littéral sans étalement ; `null` sinon. */
export function paramCount(call: ts.CallExpression): number | null {
    if (!call.arguments[1]) return 0;
    const array = paramArray(call);
    if (!array || array.elements.some(ts.isSpreadElement)) return null;
    return array.elements.length;
}

function bare(node: ts.Expression): ts.Expression {
    let n = node;
    while (
        ts.isParenthesizedExpression(n) ||
        ts.isAsExpression(n) ||
        ts.isSatisfiesExpression(n) ||
        ts.isNonNullExpression(n)
    ) {
        n = n.expression;
    }
    return n;
}

type FunctionNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isFunctionNode(n: ts.Node): n is FunctionNode {
    return (
        ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    );
}

/** Le nœud qui nomme une fonction : son propre nom, ou la constante ou la propriété qui la porte. */
function nameNode(fn: FunctionNode): ts.Node | null {
    if (!ts.isArrowFunction(fn) && fn.name) return fn.name;
    if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return null;
    const holder = fn.parent;
    return ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) ? holder.name : null;
}

/** La fonction nommée la plus proche qui contient ce nœud. */
export function namedFunction(node: ts.Node): FunctionNode | null {
    for (let n = node.parent; !ts.isSourceFile(n); n = n.parent) {
        if (isFunctionNode(n) && nameNode(n)) return n;
    }
    return null;
}

/**
 * Le nom d'une fonction dans son fichier : le sien, précédé des objets qui la
 * portent jusqu'à la fonction qui les entoure (`folders.findById`,
 * `removeFeature.handler`). Deux méthodes de même nom dans deux objets d'un
 * même dépôt ne se confondent pas.
 */
function qualifiedName(fn: FunctionNode): string {
    const own = nameNode(fn);
    const names = [own ? own.getText() : ''];
    const start = own && own.parent !== fn ? own.parent : fn;
    for (let n = start.parent; !ts.isSourceFile(n) && !isFunctionNode(n); n = n.parent) {
        if (ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) names.unshift(n.name.getText());
    }
    return names.join('.');
}

/**
 * La fonction nommée qui porte un appel, telle qu'une dispense la désigne. Une
 * fonction passée en argument (le corps d'une transaction, d'un `map`) n'a pas
 * de nom : c'est celle qui l'entoure. `<module>` hors de toute fonction.
 */
export function enclosingFunction(node: ts.Node): string {
    const fn = namedFunction(node);
    return fn ? qualifiedName(fn) : '<module>';
}

/** Le symbole sous lequel une fonction s'appelle. */
export function functionSymbol(fn: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
    const name = isFunctionNode(fn) ? nameNode(fn) : null;
    return name ? checker.getSymbolAtLocation(name) : undefined;
}

/** Chaque appel des fichiers contrôlés, rangé par la fonction appelée. */
export function callsBySymbol(program: ts.Program, workspace: string): Map<ts.Symbol, ts.CallExpression[]> {
    const checker = program.getTypeChecker();
    const out = new Map<ts.Symbol, ts.CallExpression[]>();
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
            let symbol = checker.getSymbolAtLocation(callee);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            if (symbol) out.set(symbol, [...(out.get(symbol) ?? []), node]);
        }
        ts.forEachChild(node, visit);
    };
    for (const sf of program.getSourceFiles()) if (isChecked(program, sf, workspace)) visit(sf);
    return out;
}

/**
 * L'expression est-elle l'identifiant qu'une insertion vient de rendre :
 * `res.insertId`, ou une constante qui en est tirée ?
 */
export function isInsertId(expr: ts.Expression, checker: ts.TypeChecker): boolean {
    const n = bare(expr);
    if (ts.isPropertyAccessExpression(n)) return n.name.text === 'insertId';
    if (!ts.isIdentifier(n)) return false;
    const decl = checker.getSymbolAtLocation(n)?.valueDeclaration;
    if (!decl) return false;
    if (ts.isBindingElement(decl)) return (decl.propertyName ?? decl.name).getText() === 'insertId';
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return false;
    return isInsertId(decl.initializer, checker);
}

/** Le paramètre de ce rang, quand `params` est un tableau littéral sans étalement avant lui. */
export function paramOf(params: ts.Expression | undefined, index: number): ts.Expression | null {
    const array = params ? bare(params) : undefined;
    if (!array || !ts.isArrayLiteralExpression(array)) return null;
    if (array.elements.slice(0, index + 1).some(ts.isSpreadElement)) return null;
    return array.elements[index] ?? null;
}

/** Le paramètre de ce rang de l'appel. */
export function paramAt(call: ts.CallExpression, index: number): ts.Expression | null {
    return paramOf(call.arguments[1], index);
}

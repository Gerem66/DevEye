import fs from 'node:fs';
import path from 'node:path';

import type mysql from 'mysql2';
import ts from 'typescript';

import {
    callsBySymbol,
    enclosingFunction,
    findQueryCalls,
    functionSymbol,
    isInsertId,
    paramOf,
    whereOf
} from './query-calls';
import { DynamicSql, sqlVariants } from './query-check';
import {
    callVerdict,
    classifyTables,
    scopeFindings,
    type CallVerdict,
    type Finding,
    type TableInfo
} from './query-scope';
import { loadScopeFiles, rootOf, scopeRoots, type ScopeRoot } from './scope-files';
import { DYNAMIC_SQL } from './sql-shape';

function rows<T>(conn: mysql.Connection, sql: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
        conn.query(sql, (err, result) => (err ? reject(err) : resolve(result as T[])));
    });
}

/** Les tables de la base migrée : colonnes, clé primaire, clés étrangères. */
async function loadTables(conn: mysql.Connection): Promise<Map<string, TableInfo>> {
    const tables = new Map<string, { columns: Set<string>; primaryKey: string[]; foreignKeys: Map<string, string> }>();
    const columns = await rows<{ t: string; c: string; k: string }>(
        conn,
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_KEY AS k FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    for (const { t, c, k } of columns) {
        const info = tables.get(t) ?? {
            columns: new Set<string>(),
            primaryKey: [],
            foreignKeys: new Map<string, string>()
        };
        info.columns.add(c);
        if (k === 'PRI') info.primaryKey.push(c);
        tables.set(t, info);
    }
    const keys = await rows<{ t: string; c: string; parent: string }>(
        conn,
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS parent FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
    );
    for (const { t, c, parent } of keys) tables.get(t)?.foreignKeys.set(c, parent);
    return tables;
}

const LABELS: Record<Exclude<CallVerdict, 'bounded'>, string> = {
    unbounded: 'à trier',
    unread: 'non lu(s)',
    unclassified: 'sur une table sans classe',
    exempt: 'dispensé(s)'
};

/**
 * Le cloisonnement de chaque requête du workspace (`query-scope.ts`).
 *
 * Il s'applique au socle et aux modules du dépôt, et à tout autre module qui a
 * son `deveye-scope.json` : une table sans borne ni dispense, une table sans
 * classe, une dispense qui ne couvre plus rien y sont des fautes, et leur
 * nombre est rendu. Un module sans déclaration n'est que compté.
 *
 * `report` : tout est dit, dépôt par dépôt, et rien n'est une faute.
 */
export async function scopePass(options: {
    program: ts.Program;
    conn: mysql.Connection;
    root: string;
    workspace: string;
    verbose: boolean;
    report: boolean;
}): Promise<number> {
    const { program, conn, root, workspace, verbose, report } = options;
    const checker = program.getTypeChecker();
    const schema = await loadTables(conn);
    const roots = scopeRoots(root, workspace);
    const files = loadScopeFiles(roots);
    const { scopes, unclassified, problems } = classifyTables(schema, files.declared, files.keys);
    const applied = (owner: ScopeRoot | null): boolean =>
        owner === null || owner.dir === root || owner.dir.startsWith(root + path.sep) || fs.existsSync(owner.file);

    const totals = new Map<string, Record<CallVerdict, number>>();
    const faults: string[] = [...files.problems, ...problems].map((problem) => `déclaration : ${problem}`);
    const details: string[] = [];
    const used = new Set<string>();
    let calls = 0;

    /** Juge une requête là où elle est écrite : `at` porte la clé, `sql` et `params` le texte et ses paramètres. */
    const judge = (
        at: ts.CallExpression,
        sql: ts.Expression,
        params: ts.Expression | undefined,
        bindings?: ReadonlyMap<ts.Symbol, ts.Expression>
    ): Set<ts.ParameterDeclaration> => {
        const feeding = new Set<ts.ParameterDeclaration>();
        let variants: string[];
        try {
            variants = sqlVariants(sql, checker, { tolerant: true, bindings, parameters: feeding });
        } catch (e) {
            if (!(e instanceof DynamicSql)) throw e;
            variants = [DYNAMIC_SQL];
        }
        // Un paramètre de fonction, quand la requête se lit depuis un appel de celle-ci.
        const given = (expr: ts.Expression | undefined): ts.Expression | undefined => {
            const symbol = expr && ts.isIdentifier(expr) ? checker.getSymbolAtLocation(expr) : undefined;
            return (symbol && bindings?.get(symbol)) ?? expr;
        };
        const rowId = (param: number): boolean => {
            const value = paramOf(given(params), param);
            return value !== null && isInsertId(value, checker);
        };
        const found = new Map<string, Finding>();
        for (const text of variants) {
            for (const finding of scopeFindings(text, schema, scopes, { rowId })) found.set(finding.message, finding);
        }
        // Lue depuis un appel, elle n'est jugée que si elle se lit : sinon c'est à l'aide de la porter.
        if (bindings === undefined && feeding.size > 0) return feeding;

        calls++;
        const file = at.getSourceFile().fileName;
        const owner = rootOf(file, roots);
        const key = `${path.relative(owner?.dir ?? root, file)}#${enclosingFunction(at)}`;
        const exemption = owner?.exempt.get(key);
        const findings = [...found.values()];
        const verdict = callVerdict(findings, exemption !== undefined);
        if (verdict === 'exempt') used.add(`${owner?.label} ${key}`);

        const label = owner?.label ?? '.';
        const tally = totals.get(label) ?? { bounded: 0, exempt: 0, unbounded: 0, unclassified: 0, unread: 0 };
        tally[verdict]++;
        totals.set(label, tally);
        if (verdict !== 'bounded') {
            const why = verdict === 'exempt' ? `  [${exemption?.kind} : ${exemption?.reason}]` : '';
            for (const finding of findings) {
                const line = `${whereOf(at, workspace)}  ${key}  ${finding.message}${why}`;
                details.push(line);
                if (verdict !== 'exempt' && applied(owner)) faults.push(line);
            }
        }
        return new Set();
    };

    let sites: Map<ts.Symbol, ts.CallExpression[]> | null = null;
    for (const call of findQueryCalls(program, workspace)) {
        const [sql, params] = call.arguments;
        const feeding = judge(call, sql, params);
        if (feeding.size === 0) continue;

        // Le texte arrive par un paramètre : une aide (`one(sql, params)`). La
        // requête se juge à chaque appel de l'aide, là où elle est écrite.
        const helper = [...feeding][0].parent;
        const symbol = functionSymbol(helper, checker);
        sites ??= callsBySymbol(program, workspace);
        const callers = (symbol && sites.get(symbol)) ?? [];
        if (callers.length === 0) {
            judge(call, sql, params, new Map());
            continue;
        }
        for (const caller of callers) {
            const bindings = new Map<ts.Symbol, ts.Expression>();
            helper.parameters.forEach((parameter, index) => {
                const own = checker.getSymbolAtLocation(parameter.name);
                const argument = caller.arguments[index];
                if (own && argument) bindings.set(own, argument);
            });
            judge(caller, sql, params, bindings);
        }
    }

    for (const owner of roots) {
        for (const key of owner.exempt.keys()) {
            if (!used.has(`${owner.label} ${key}`))
                faults.push(`${owner.label} : la dispense « ${key} » ne couvre plus rien`);
        }
    }

    const sum = (verdict: CallVerdict): number => [...totals.values()].reduce((n, t) => n + t[verdict], 0);
    const loose = roots.filter((owner) => !applied(owner) && totals.has(owner.label)).map((owner) => owner.label);
    console.log(
        `cloisonnement : ${calls} appel(s), ${sum('bounded')} borné(s), ${sum('exempt')} dispensé(s), ` +
            `${sum('unbounded')} à trier, ${sum('unread')} non lu(s), ${sum('unclassified')} sur une table sans classe`
    );
    if (loose.length > 0)
        console.log(`  comptés sans être appliqués, faute de deveye-scope.json : ${loose.join(', ')}`);

    if (report) {
        const width = Math.max(0, ...[...totals.keys()].map((label) => label.length));
        for (const [label, tally] of [...totals].sort((a, b) => b[1].unbounded - a[1].unbounded)) {
            const parts = (Object.keys(LABELS) as (keyof typeof LABELS)[])
                .filter((verdict) => tally[verdict] > 0)
                .map((verdict) => `${tally[verdict]} ${LABELS[verdict]}`);
            if (parts.length > 0) console.log(`  ${label.padEnd(width)}  ${parts.join(', ')}`);
        }
        if (unclassified.length > 0) {
            console.log(`tables sans classe (${unclassified.length}) : ${unclassified.join(', ')}`);
        }
        for (const fault of faults.filter((f) => !details.includes(f))) console.log(fault);
        if (verbose) for (const line of details.sort()) console.log(`  ${line}`);
        else if (details.length > 0) console.log('(--verbose : chaque requête, sa fonction et ce qui lui manque)');
        return 0;
    }
    for (const fault of faults) console.error(`✗ ${fault}`);
    return faults.length;
}

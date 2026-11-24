import path from 'node:path';

import type mysql from 'mysql2';
import ts from 'typescript';

import { enclosingFunction, findQueryCalls, isInsertId, paramAt, whereOf } from './query-calls';
import { DynamicSql, sqlVariants } from './query-check';
import {
    callVerdict,
    classifyTables,
    scopeFindings,
    type CallVerdict,
    type Finding,
    type TableInfo
} from './query-scope';
import { loadScopeFiles, rootOf, scopeRoots } from './scope-files';

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
    exempt: 'dispensé(s)',
    unclassified: 'sur une table sans classe',
    unread: 'non analysé(s)'
};

/**
 * `check:queries -- --scope-report` : ce que l'analyse de cloisonnement dit de
 * chaque requête du workspace, sans rien faire échouer. Le détail avec
 * `--verbose`.
 */
export async function scopeReport(options: {
    program: ts.Program;
    conn: mysql.Connection;
    root: string;
    workspace: string;
    verbose: boolean;
}): Promise<void> {
    const { program, conn, root, workspace, verbose } = options;
    const checker = program.getTypeChecker();
    const schema = await loadTables(conn);
    const roots = scopeRoots(root, workspace);
    const files = loadScopeFiles(roots);
    const { scopes, unclassified, problems } = classifyTables(schema, files.declared);

    const totals = new Map<string, Record<CallVerdict, number>>();
    const lines: string[] = [];
    const used = new Set<string>();
    let dynamic = 0;
    let calls = 0;

    for (const call of findQueryCalls(program, workspace)) {
        calls++;
        let variants: string[];
        try {
            variants = sqlVariants(call.arguments[0], checker);
        } catch (e) {
            if (!(e instanceof DynamicSql)) throw e;
            dynamic++;
            continue;
        }
        const rowId = (param: number): boolean => {
            const given = paramAt(call, param);
            return given !== null && isInsertId(given, checker);
        };
        const found = new Map<string, Finding>();
        for (const sql of variants) {
            for (const finding of scopeFindings(sql, schema, scopes, { rowId })) found.set(finding.message, finding);
        }
        const file = call.getSourceFile().fileName;
        const owner = rootOf(file, roots);
        const key = `${path.relative(owner?.dir ?? root, file)}#${enclosingFunction(call)}`;
        const exemption = owner?.exempt.get(key);
        const findings = [...found.values()];
        const verdict = callVerdict(findings, exemption !== undefined);
        if (verdict === 'exempt') used.add(`${owner?.label} ${key}`);

        const label = owner?.label ?? '.';
        const tally = totals.get(label) ?? { bounded: 0, exempt: 0, unbounded: 0, unclassified: 0, unread: 0 };
        tally[verdict]++;
        totals.set(label, tally);
        if (verdict === 'bounded') continue;
        const why = verdict === 'exempt' ? `  [${exemption?.kind} : ${exemption?.reason}]` : '';
        for (const finding of findings) lines.push(`  ${whereOf(call, workspace)}  ${key}  ${finding.message}${why}`);
    }

    for (const owner of roots) {
        for (const key of owner.exempt.keys()) {
            if (!used.has(`${owner.label} ${key}`))
                problems.push(`${owner.label} : la dispense « ${key} » ne couvre plus rien`);
        }
    }

    const sum = (verdict: CallVerdict): number => [...totals.values()].reduce((n, t) => n + t[verdict], 0);
    console.log(
        `cloisonnement : ${calls} appel(s), ${sum('bounded')} borné(s), ${sum('unbounded')} à trier, ` +
            `${sum('exempt')} dispensé(s), ${sum('unclassified')} sur une table sans classe, ` +
            `${sum('unread')} non analysé(s), ${dynamic} dynamique(s)`
    );
    const width = Math.max(...[...totals.keys()].map((label) => label.length));
    for (const [label, tally] of [...totals].sort((a, b) => b[1].unbounded - a[1].unbounded)) {
        const parts = (Object.keys(LABELS) as (keyof typeof LABELS)[])
            .filter((verdict) => tally[verdict] > 0)
            .map((verdict) => `${tally[verdict]} ${LABELS[verdict]}`);
        if (parts.length > 0) console.log(`  ${label.padEnd(width)}  ${parts.join(', ')}`);
    }
    if (unclassified.length > 0) {
        console.log(`tables sans classe (${unclassified.length}) : ${unclassified.join(', ')}`);
    }
    for (const problem of problems) console.log(`déclaration : ${problem}`);
    if (verbose) for (const line of lines.sort()) console.log(line);
    else if (lines.length > 0) console.log('(--verbose : chaque requête, sa fonction et ce qui lui manque)');
}

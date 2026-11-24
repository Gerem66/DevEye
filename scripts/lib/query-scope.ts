import { z } from 'zod';

import { readSql, UnreadSql, type Block, type ColumnRef, type Cond, type Query, type TableRef } from './sql-shape';

/**
 * Le cloisonnement d'une requête, lu dans son texte : chaque table qu'elle cite
 * est-elle bornée à un espace, à un compte, ou à des lignes qui le sont déjà ?
 * Un `AND workspace_id = ?` oublié n'échoue nulle part, la requête rend
 * simplement les lignes des autres.
 *
 * La classe d'une table se lit dans la base : `direct` si elle porte
 * `workspace_id`, `child` si une clé étrangère la mène à une table bornée.
 * Les autres se déclarent, `account` avec leurs colonnes ou `instance` avec
 * leur raison.
 */

export interface TableInfo {
    columns: ReadonlySet<string>;
    /** Vide sans clé primaire. */
    primaryKey: readonly string[];
    /** Colonne, puis la table qu'elle référence. */
    foreignKeys: ReadonlyMap<string, string>;
}

export type Schema = ReadonlyMap<string, TableInfo>;

const tableDeclarationSchema = z.discriminatedUnion('class', [
    /** Bornée par un compte, ou par elle-même : un prédicat sur l'une de ces colonnes suffit. */
    z.strictObject({ class: z.literal('account'), columns: z.array(z.string().min(1)).min(1) }),
    /** Fille d'une table bornée que le schéma ne dit pas par une clé étrangère : colonne, puis parent. */
    z.strictObject({ class: z.literal('child'), parents: z.record(z.string().min(1), z.string().min(1)) }),
    /** Commune à toute l'instance : aucune ligne n'y appartient à quelqu'un. */
    z.strictObject({ class: z.literal('instance'), reason: z.string().min(1) })
]);

const exemptionSchema = z.strictObject({
    /**
     * `service` : un service de fond lit tous les espaces. `token` : un secret
     * que seul son porteur détient désigne la ligne. `row` : la ligne vient
     * d'une lecture déjà bornée. `instance` : une lecture d'administration.
     */
    kind: z.enum(['service', 'token', 'row', 'instance']),
    reason: z.string().min(1)
});

/** Un `deveye-scope.json` de module, ou le `src/db/scope.json` du socle. */
export const scopeFileSchema = z.strictObject({
    $comment: z.string().optional(),
    tables: z.record(z.string(), tableDeclarationSchema).default({}),
    /** `fichier#fonction`, le fichier depuis la racine du module. */
    exempt: z.record(z.string().regex(/^[^#]+#[^#]+$/), exemptionSchema).default({})
});

export type TableDeclaration = z.infer<typeof tableDeclarationSchema>;
export type Exemption = z.infer<typeof exemptionSchema>;
export type ScopeFile = z.infer<typeof scopeFileSchema>;

export interface TableScope {
    class: 'direct' | 'child' | 'account' | 'instance';
    /** Un prédicat sur l'une d'elles borne les lignes. */
    columns: readonly string[];
    /** Bornent aussi, mais seulement jointes à des lignes déjà bornées. */
    joins: readonly string[];
}

const WORKSPACE_COLUMNS = ['workspace_id', 'home_workspace_id'];

/** La colonne qui désigne une ligne à elle seule, quand la clé primaire n'en a qu'une. */
function rowIdOf(info: TableInfo): string | null {
    return info.primaryKey.length === 1 ? info.primaryKey[0] : null;
}

/**
 * La classe de chaque table. `unclassified` : celles que ni le schéma ni une
 * déclaration ne rangent. `problems` : les déclarations fausses ou devenues
 * inutiles.
 */
export function classifyTables(
    schema: Schema,
    declared: ReadonlyMap<string, TableDeclaration>
): { scopes: Map<string, TableScope>; unclassified: string[]; problems: string[] } {
    const scopes = new Map<string, TableScope>();
    const problems: string[] = [];
    const columns = new Map<string, string[]>();

    for (const [table, info] of schema) {
        const own = WORKSPACE_COLUMNS.filter((c) => info.columns.has(c));
        if (own.length > 0) columns.set(table, own);
    }
    const direct = new Set(columns.keys());

    for (const [table, decl] of declared) {
        const info = schema.get(table);
        if (!info) {
            problems.push(`« ${table} » est déclarée, mais la base ne la connaît pas`);
            continue;
        }
        if (direct.has(table)) {
            problems.push(`« ${table} » porte ${columns.get(table)?.join(', ')} : elle n'a pas à être déclarée`);
            continue;
        }
        if (decl.class === 'instance') {
            scopes.set(table, { class: 'instance', columns: [], joins: [] });
            continue;
        }
        const named = decl.class === 'account' ? decl.columns : Object.keys(decl.parents);
        const missing = named.filter((c) => !info.columns.has(c));
        if (missing.length > 0) {
            problems.push(`« ${table} » : colonne déclarée inconnue (${missing.join(', ')})`);
            continue;
        }
        if (decl.class === 'account') scopes.set(table, { class: 'account', columns: decl.columns, joins: [] });
        else columns.set(table, named);
    }

    // Une clé étrangère vers une table d'espace fait une fille, de proche en
    // proche. Jamais vers un compte : `updated_by` y mène sans rien borner.
    for (let grew = true; grew;) {
        grew = false;
        for (const [table, info] of schema) {
            if (columns.has(table) || scopes.has(table)) continue;
            const via = [...info.foreignKeys].filter(([, parent]) => columns.has(parent)).map(([column]) => column);
            if (via.length === 0) continue;
            columns.set(table, via);
            grew = true;
        }
    }

    for (const [table, decl] of declared) {
        if (decl.class !== 'child' || !columns.has(table)) continue;
        const loose = Object.values(decl.parents).filter((parent) => !columns.has(parent));
        if (loose.length === 0) continue;
        problems.push(`« ${table} » : parent déclaré qui n'est pas une table d'espace (${loose.join(', ')})`);
        columns.delete(table);
    }

    for (const [table, own] of columns) {
        if (direct.has(table)) {
            scopes.set(table, { class: 'direct', columns: own, joins: [] });
            continue;
        }
        // Toutes ses clés vers une table d'espace, pas seulement la première trouvée.
        const keys = [...(schema.get(table)?.foreignKeys ?? [])].filter(([, parent]) => columns.has(parent));
        scopes.set(table, { class: 'child', columns: [...new Set([...own, ...keys.map(([c]) => c)])], joins: [] });
    }
    // Une jointure ne borne que dans son monde : l'auteur d'une ligne d'espace
    // ne dit pas dans quel espace elle est.
    const realm = (table: string): 'workspace' | 'account' | null => {
        const kind = scopes.get(table)?.class;
        if (kind === 'direct' || kind === 'child') return 'workspace';
        return kind === 'account' ? 'account' : null;
    };
    for (const [table, scope] of scopes) {
        const info = schema.get(table);
        if (!info || scope.class === 'instance') continue;
        const joins = [...info.foreignKeys]
            .filter(([column, parent]) => !scope.columns.includes(column) && realm(parent) === realm(table))
            .map(([column]) => column);
        scopes.set(table, { ...scope, joins });
    }

    const unclassified = [...schema.keys()].filter((table) => !scopes.has(table)).sort();
    return { scopes, unclassified, problems };
}

export interface Finding {
    /** `unbounded` : une table sans borne. `unclassified` : une table sans classe. `unread` : une requête illisible. */
    kind: 'unbounded' | 'unclassified' | 'unread';
    table: string | null;
    message: string;
}

export interface ScopeOptions {
    /**
     * Le paramètre de ce rang (celui de son `?`) est-il l'identifiant d'une
     * ligne que l'appelant vient d'insérer ? `WHERE id = ?` la borne alors.
     */
    rowId?(param: number): boolean;
}

type Anchored = ReadonlySet<TableRef>;

function union(a: Anchored, b: Anchored): Set<TableRef> {
    return new Set([...a, ...b]);
}

function intersect(a: Anchored | null, b: Anchored): Set<TableRef> {
    return a === null ? new Set(b) : new Set([...a].filter((r) => b.has(r)));
}

class Analysis {
    readonly findings: Finding[] = [];
    private readonly checked = new Set<Query>();
    private readonly schema: Schema;
    private readonly scopes: ReadonlyMap<string, TableScope>;
    private readonly rowId: (param: number) => boolean;

    constructor(schema: Schema, scopes: ReadonlyMap<string, TableScope>, options: ScopeOptions) {
        this.schema = schema;
        this.scopes = scopes;
        this.rowId = options.rowId ?? (() => false);
    }

    private info(ref: TableRef): TableInfo | undefined {
        return ref.table !== null && !ref.foreign ? this.schema.get(ref.table) : undefined;
    }

    private scope(ref: TableRef): TableScope | undefined {
        return this.info(ref) && ref.table !== null ? this.scopes.get(ref.table) : undefined;
    }

    /** La table qu'une colonne désigne : dans son bloc d'abord, puis dans ceux qui l'entourent. */
    private resolve(column: ColumnRef, chain: readonly Block[]): TableRef | null {
        for (let depth = chain.length - 1; depth >= 0; depth--) {
            const { refs } = chain[depth];
            if (column.qualifier !== null) {
                const wanted = column.qualifier.toLowerCase();
                const found = refs.find((r) => r.alias.toLowerCase() === wanted);
                if (found) return found;
                continue;
            }
            const holders = refs.filter((r) => this.info(r)?.columns.has(column.name));
            if (holders.length === 1) return holders[0];
            if (holders.length > 1) return null;
            const derived = refs.filter((r) => r.query !== null);
            if (derived.length === 1) return derived[0];
            if (derived.length > 1) return null;
        }
        return null;
    }

    /** Une table dérivée se vérifie par sa propre requête : ses lignes sont tenues pour bornées. */
    private known(ref: TableRef, anchored: Anchored): boolean {
        return ref.query !== null || anchored.has(ref);
    }

    /** Cette colonne, égale à celle d'une ligne bornée, borne-t-elle sa table ? */
    private keyed(ref: TableRef, column: string): boolean {
        const scope = this.scope(ref);
        const info = this.info(ref);
        if (!scope || !info) return false;
        return scope.columns.includes(column) || scope.joins.includes(column) || rowIdOf(info) === column;
    }

    /** Les tables qu'une condition borne, quand elle est vraie et que `env` l'est déjà. */
    private anchors(cond: Cond, chain: readonly Block[], env: Anchored): Set<TableRef> {
        switch (cond.kind) {
            case 'and': {
                const acc = new Set<TableRef>();
                for (;;) {
                    const before = acc.size;
                    for (const item of cond.items) {
                        for (const ref of this.anchors(item, chain, union(env, acc))) acc.add(ref);
                    }
                    if (acc.size === before) return acc;
                }
            }
            case 'or': {
                let common: Set<TableRef> | null = null;
                for (const item of cond.items) common = intersect(common, this.anchors(item, chain, env));
                return common ?? new Set();
            }
            case 'bound': {
                const ref = this.resolve(cond.column, chain);
                const scope = ref && this.scope(ref);
                if (!ref || !scope) return new Set();
                if (scope.columns.includes(cond.column.name)) return new Set([ref]);
                const info = this.info(ref);
                if (cond.param === null || !info || scope.class === 'instance') return new Set();
                return rowIdOf(info) === cond.column.name && this.rowId(cond.param) ? new Set([ref]) : new Set();
            }
            case 'link': {
                const left = this.resolve(cond.left, chain);
                const right = this.resolve(cond.right, chain);
                const out = new Set<TableRef>();
                if (!left || !right || left === right) return out;
                if (this.known(right, env) && this.keyed(left, cond.left.name)) out.add(left);
                if (this.known(left, env) && this.keyed(right, cond.right.name)) out.add(right);
                return out;
            }
            case 'exists': {
                let common: Set<TableRef> | null = null;
                for (const arm of cond.query) {
                    const got = this.anchors(arm.cond, [...chain, arm], env);
                    common = intersect(common, new Set([...got].filter((r) => !arm.refs.includes(r))));
                }
                return common ?? new Set();
            }
            case 'in': {
                const ref = this.resolve(cond.column, chain);
                if (!ref || !this.keyed(ref, cond.column.name)) return new Set();
                for (const arm of cond.query) {
                    const inside = [...chain, arm];
                    const source = arm.first && this.resolve(arm.first, inside);
                    if (!source || !arm.refs.includes(source)) return new Set();
                    if (!this.known(source, this.anchors(arm.cond, inside, env))) return new Set();
                }
                return new Set([ref]);
            }
            case 'only': {
                const own = chain[chain.length - 1].refs;
                const got = this.anchors(cond.item, chain, env);
                return new Set([...got].filter((r) => own.includes(r) && r.alias === cond.alias));
            }
            case 'opaque':
                return new Set();
        }
    }

    private add(kind: Finding['kind'], table: string | null, message: string): void {
        if (!this.findings.some((f) => f.kind === kind && f.message === message)) {
            this.findings.push({ kind, table, message });
        }
    }

    /** `false` : la table n'a pas à être bornée. */
    private owned(table: string): TableScope | false {
        if (!this.schema.has(table)) return false;
        const scope = this.scopes.get(table);
        if (!scope) {
            this.add('unclassified', table, `« ${table} » : table sans classe, à déclarer « account » ou « instance »`);
            return false;
        }
        return scope.class === 'instance' ? false : scope;
    }

    check(query: Query, chain: readonly Block[], env: Anchored): void {
        if (this.checked.has(query)) return;
        this.checked.add(query);
        for (const block of query) {
            const all = union(env, this.anchors(block.cond, [...chain, block], env));
            for (const ref of block.refs) {
                if (ref.query !== null) {
                    this.check(ref.query, chain, env);
                    continue;
                }
                if (ref.table === null || ref.foreign) continue;
                const scope = this.owned(ref.table);
                if (!scope || all.has(ref)) continue;
                const on = scope.columns.join(' ou ');
                this.add(
                    'unbounded',
                    ref.table,
                    scope.class === 'child'
                        ? `« ${ref.table} » : ni prédicat sur ${on}, ni jointure vers un parent borné`
                        : `« ${ref.table} » : aucun prédicat sur ${on}`
                );
            }
            for (const nested of block.nested) this.check(nested, [...chain, block], all);
        }
    }

    insert(table: string, columns: readonly string[] | null): void {
        const scope = this.owned(table);
        const info = this.schema.get(table);
        if (!scope || !info) return;
        // La ligne qui s'insère EST la racine (un compte, un espace) : rien ne la borne encore.
        if (scope.columns.includes(rowIdOf(info) ?? '')) return;
        const on = scope.columns.join(' ou ');
        if (columns === null) {
            this.add('unbounded', table, `« ${table} » : insertion sans liste de colonnes, ${on} ne s'y lit pas`);
        } else if (!scope.columns.some((c) => columns.includes(c))) {
            this.add('unbounded', table, `« ${table} » : ${on} absent de la liste de colonnes de l'insertion`);
        }
    }
}

/**
 * Ce qui, dans cette requête, n'est pas borné. Vide : chaque table citée l'est,
 * ou n'a pas à l'être.
 */
export function scopeFindings(
    sql: string,
    schema: Schema,
    scopes: ReadonlyMap<string, TableScope>,
    options: ScopeOptions = {}
): Finding[] {
    const analysis = new Analysis(schema, scopes, options);
    try {
        const statement = readSql(sql);
        if (statement.kind === 'other') return [];
        const none = new Set<TableRef>();
        for (const cte of statement.ctes) analysis.check(cte, [], none);
        if (statement.kind === 'select') analysis.check(statement.query, [], none);
        if (statement.kind === 'write') analysis.check([statement.block], [], none);
        if (statement.kind === 'insert') {
            analysis.insert(statement.table, statement.columns);
            if (statement.select) analysis.check(statement.select, [], none);
            for (const nested of statement.nested) analysis.check(nested, [], none);
        }
    } catch (e) {
        if (!(e instanceof UnreadSql)) throw e;
        return [{ kind: 'unread', table: null, message: `requête non analysée : ${e.message}` }];
    }
    return analysis.findings;
}

/** Le sort d'un appel, toutes ses variantes confondues. */
export type CallVerdict = 'bounded' | 'exempt' | 'unbounded' | 'unclassified' | 'unread';

/**
 * Une dispense couvre une table sans borne, jamais une requête illisible ni
 * une table sans classe : celles-là se corrigent, elles ne se justifient pas.
 */
export function callVerdict(findings: readonly Finding[], exempt: boolean): CallVerdict {
    const has = (kind: Finding['kind']): boolean => findings.some((f) => f.kind === kind);
    if (has('unread')) return 'unread';
    if (has('unclassified')) return 'unclassified';
    if (has('unbounded')) return exempt ? 'exempt' : 'unbounded';
    return 'bounded';
}

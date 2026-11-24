/**
 * La forme d'une requête SQL, sans base : ses tables et leurs alias, ses
 * conditions avec leur structure ET / OU, ses sous-requêtes. Juste ce qu'il
 * faut pour dire si chaque table est bornée (`query-scope.ts`), pas une
 * grammaire de MySQL : une tournure hors de ce que le workspace écrit lève
 * `UnreadSql`, et la requête compte comme non analysée plutôt que comme saine.
 */

export class UnreadSql extends Error {}

/**
 * Ce qui tient lieu, dans le texte, d'un morceau que le code assemble à
 * l'exécution. Il se tolère là où il ne peut cacher ni table ni OU : la liste
 * rendue, un SET, des valeurs, un tri, ou l'intérieur d'une parenthèse d'une
 * condition. Ailleurs la requête n'est pas lue.
 */
export const DYNAMIC_SQL = '__DYNAMIC__';

export interface Token {
    kind: 'word' | 'num' | 'str' | 'param' | 'punct';
    text: string;
    /** En majuscules pour un mot nu, vide pour un identifiant entre accents graves : jamais un mot-clé. */
    upper: string;
    /** Le rang du `?` dans la requête, pour un paramètre. */
    param: number;
}

export interface ColumnRef {
    /** L'alias ou la table devant le point, `null` pour une colonne nue. */
    qualifier: string | null;
    name: string;
}

export interface TableRef {
    alias: string;
    /** `null` pour une table dérivée ou une CTE. */
    table: string | null;
    /** La table vient d'un autre schéma (`information_schema`). */
    foreign: boolean;
    /** La sous-requête d'une table dérivée ou d'une CTE. */
    query: Query | null;
}

export type Cond =
    | { kind: 'and' | 'or'; items: Cond[] }
    /** `colonne = constante` ou `colonne IN (constantes)`. `param` : le rang du `?` quand la constante n'est que lui. */
    | { kind: 'bound'; column: ColumnRef; param: number | null }
    | { kind: 'link'; left: ColumnRef; right: ColumnRef }
    | { kind: 'exists'; query: Query }
    /** `colonne IN (sous-requête)` ou `colonne = (sous-requête)`. */
    | { kind: 'in'; column: ColumnRef; query: Query }
    /** Une condition qui ne restreint que la table jointe : le ON d'un LEFT JOIN. */
    | { kind: 'only'; alias: string; item: Cond }
    | { kind: 'opaque' };

export interface Block {
    refs: TableRef[];
    cond: Cond;
    /** Toute sous-requête du bloc, où qu'elle soit : chacune se vérifie pour elle-même. */
    nested: Query[];
    /** La première colonne rendue, quand c'en est une : ce qu'un `IN (sous-requête)` compare. */
    first: ColumnRef | null;
}

/** Les branches d'un UNION ; une seule sans lui. */
export type Query = Block[];

export type Statement =
    | { kind: 'select'; query: Query; ctes: Query[] }
    | { kind: 'insert'; table: string; columns: string[] | null; select: Query | null; nested: Query[]; ctes: Query[] }
    | { kind: 'write'; block: Block; ctes: Query[] }
    | { kind: 'other' };

const OPERATORS = ['<=>', '->>', '<>', '!=', '<=', '>=', ':=', '||', '&&', '->'];

export function tokenize(sql: string): Token[] {
    const tokens: Token[] = [];
    let params = 0;
    let i = 0;
    const push = (kind: Token['kind'], text: string, upper = ''): void => {
        tokens.push({ kind, text, upper, param: kind === 'param' ? params++ : -1 });
    };
    while (i < sql.length) {
        const c = sql[i];
        if (/\s/.test(c)) {
            i++;
        } else if (c === '#' || (c === '-' && sql[i + 1] === '-' && /\s|^$/.test(sql[i + 2] ?? ''))) {
            while (i < sql.length && sql[i] !== '\n') i++;
        } else if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
        } else if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === '\\') j += 2;
                else if (sql[j] === c && sql[j + 1] === c) j += 2;
                else if (sql[j] === c) break;
                else j++;
            }
            push('str', sql.slice(i, j + 1));
            i = j + 1;
        } else if (c === '`') {
            const end = sql.indexOf('`', i + 1);
            if (end === -1) throw new UnreadSql('accent grave non refermé');
            push('word', sql.slice(i + 1, end));
            i = end + 1;
        } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
            const m = /^[0-9]*\.?[0-9]*(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i));
            const text = m?.[0] ?? c;
            push('num', text);
            i += text.length;
        } else if (/[A-Za-z_$\u0080-￿]/.test(c)) {
            const m = /^[A-Za-z0-9_$\u0080-￿]+/.exec(sql.slice(i));
            const text = m?.[0] ?? c;
            push('word', text, text.toUpperCase());
            i += text.length;
        } else if (c === '?') {
            push('param', c);
            i++;
        } else {
            const op = OPERATORS.find((o) => sql.startsWith(o, i)) ?? c;
            push('punct', op);
            i += op.length;
        }
    }
    return tokens;
}

/** Les mots qu'une expression constante peut porter sans désigner une colonne. */
const CONSTANT_WORDS = new Set([
    'NULL',
    'TRUE',
    'FALSE',
    'INTERVAL',
    'SECOND',
    'MINUTE',
    'HOUR',
    'DAY',
    'WEEK',
    'MONTH',
    'YEAR',
    'AS',
    'CHAR',
    'BINARY',
    'SIGNED',
    'UNSIGNED',
    'DECIMAL',
    'DATE',
    'DATETIME',
    'DIV',
    'MOD',
    'CURRENT_TIMESTAMP',
    'CURRENT_DATE'
]);

/** Ce qui ferme une liste de tables ou l'alias d'une table. */
const AFTER_TABLE = new Set([
    'ON',
    'USING',
    'JOIN',
    'INNER',
    'LEFT',
    'RIGHT',
    'CROSS',
    'NATURAL',
    'STRAIGHT_JOIN',
    'WHERE',
    'SET',
    'GROUP',
    'HAVING',
    'ORDER',
    'LIMIT',
    'UNION',
    'FOR',
    'LOCK',
    'USE',
    'FORCE',
    'IGNORE',
    'PARTITION',
    'WINDOW'
]);

const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN']);

class Reader {
    private readonly t: Token[];
    private readonly close = new Map<number, number>();
    private readonly ctes = new Map<string, Query>();

    constructor(tokens: Token[]) {
        this.t = tokens;
        const t = tokens;
        const open: number[] = [];
        t.forEach((tok, i) => {
            if (tok.kind !== 'punct') return;
            if (tok.text === '(') open.push(i);
            else if (tok.text === ')') {
                const from = open.pop();
                if (from === undefined) throw new UnreadSql('parenthèse fermante en trop');
                this.close.set(from, i);
            }
        });
        if (open.length > 0) throw new UnreadSql('parenthèse non refermée');
    }

    private is(i: number, ...words: string[]): boolean {
        const tok = this.t[i];
        return tok !== undefined && tok.kind === 'word' && words.includes(tok.upper);
    }

    private punct(i: number, text: string): boolean {
        const tok = this.t[i];
        return tok !== undefined && tok.kind === 'punct' && tok.text === text;
    }

    private dynamic(lo: number, hi: number): boolean {
        for (const i of this.top(lo, hi)) if (this.t[i].kind === 'word' && this.t[i].text === DYNAMIC_SQL) return true;
        return false;
    }

    /** La parenthèse fermante de celle ouverte en `i`. */
    private end(i: number): number {
        const j = this.close.get(i);
        if (j === undefined) throw new UnreadSql('parenthèse attendue');
        return j;
    }

    /** Les positions de `[lo, hi)` hors de toute parenthèse et de tout CASE. */
    private *top(lo: number, hi: number): Generator<number> {
        let depth = 0;
        for (let i = lo; i < hi; i++) {
            if (this.punct(i, '(')) {
                i = this.end(i);
                continue;
            }
            if (this.is(i, 'CASE')) depth++;
            else if (this.is(i, 'END') && depth > 0) {
                depth--;
                continue;
            }
            if (depth === 0) yield i;
        }
    }

    private find(lo: number, hi: number, ...words: string[]): number {
        for (const i of this.top(lo, hi)) if (this.is(i, ...words)) return i;
        return -1;
    }

    /** Une parenthèse ouverte en `i` contient-elle une requête ? */
    private opensQuery(i: number): boolean {
        let j = i + 1;
        while (this.punct(j, '(')) j++;
        return this.is(j, 'SELECT', 'WITH');
    }

    statement(): Statement {
        let lo = 0;
        const hi = this.t.length;
        const ctes: Query[] = [];
        if (this.is(lo, 'WITH')) {
            lo++;
            if (this.is(lo, 'RECURSIVE')) lo++;
            for (;;) {
                const name = this.t[lo];
                if (!name || name.kind !== 'word') throw new UnreadSql('nom de CTE attendu');
                lo++;
                if (this.punct(lo, '(')) lo = this.end(lo) + 1;
                if (!this.is(lo, 'AS') || !this.punct(lo + 1, '(')) throw new UnreadSql('CTE sans corps');
                const close = this.end(lo + 1);
                // Inscrite avant son corps : une CTE récursive se lit elle-même.
                const query: Query = [];
                this.ctes.set(name.text, query);
                query.push(...this.query(lo + 2, close));
                ctes.push(query);
                lo = close + 1;
                if (!this.punct(lo, ',')) break;
                lo++;
            }
        }
        if (this.is(lo, 'SELECT') || this.punct(lo, '(')) return { kind: 'select', query: this.query(lo, hi), ctes };
        if (this.is(lo, 'INSERT', 'REPLACE')) return this.insert(lo, hi, ctes);
        if (this.is(lo, 'UPDATE')) return this.update(lo, hi, ctes);
        if (this.is(lo, 'DELETE')) return this.remove(lo, hi, ctes);
        if (this.t.some((tok) => tok.kind === 'word' && tok.text === DYNAMIC_SQL))
            throw new UnreadSql('requête calculée');
        return { kind: 'other' };
    }

    private query(lo: number, hi: number): Query {
        if (this.is(lo, 'WITH')) throw new UnreadSql('CTE dans une sous-requête');
        const cuts = [...this.top(lo, hi)].filter((i) => this.is(i, 'UNION', 'INTERSECT', 'EXCEPT'));
        if (cuts.length > 0) {
            const arms: Query = [];
            let from = lo;
            for (const cut of [...cuts, hi]) {
                arms.push(...this.query(from, cut));
                from = this.is(cut + 1, 'ALL', 'DISTINCT') ? cut + 2 : cut + 1;
            }
            return arms;
        }
        if (this.punct(lo, '(')) {
            // `(SELECT …) ORDER BY …` : ce qui suit la parenthèse ne nomme aucune table.
            return this.query(lo + 1, this.end(lo));
        }
        if (!this.is(lo, 'SELECT')) throw new UnreadSql('SELECT attendu');
        return [this.select(lo, hi)];
    }

    private select(lo: number, hi: number): Block {
        const from = this.find(lo + 1, hi, 'FROM');
        const nested: Query[] = [];
        const listEnd = from === -1 ? hi : from;
        this.collect(lo + 1, listEnd, nested);
        const first = this.firstColumn(lo + 1, listEnd);
        if (from === -1) {
            if (this.dynamic(lo + 1, hi)) throw new UnreadSql('FROM peut-être calculé');
            return { refs: [], cond: { kind: 'opaque' }, nested, first };
        }

        const clause = (start: number): number => {
            for (const i of this.top(start, hi)) {
                if (this.is(i, 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'FOR', 'LOCK')) return i;
            }
            return hi;
        };
        const tablesEnd = clause(from + 1);
        const { refs, conds } = this.tables(from + 1, tablesEnd, nested);
        let at = tablesEnd;
        while (at < hi) {
            const next = clause(at + 1);
            if (this.is(at, 'WHERE')) conds.push(this.cond(at + 1, next, nested));
            // Un HAVING restreint des groupes, pas des lignes : il ne borne rien.
            else this.collect(at + 1, next, nested);
            at = next;
        }
        return { refs, cond: { kind: 'and', items: conds }, nested, first };
    }

    /** Les tables de `[lo, hi)`, et la condition de chaque jointure. */
    private tables(lo: number, hi: number, nested: Query[]): { refs: TableRef[]; conds: Cond[] } {
        // Un morceau calculé ici peut être une table, une jointure ou un WHERE entier.
        if (this.dynamic(lo, hi)) throw new UnreadSql('liste de tables calculée');
        const refs: TableRef[] = [];
        const conds: Cond[] = [];
        let i = lo;
        let outer = false;
        for (;;) {
            const read = this.table(i, hi);
            refs.push(read.ref);
            i = read.next;
            if (this.is(i, 'ON')) {
                let end = hi;
                for (const j of this.top(i + 1, hi)) {
                    if (this.is(j, ...JOIN_WORDS) || this.punct(j, ',')) {
                        end = j;
                        break;
                    }
                }
                const on = this.cond(i + 1, end, nested);
                conds.push(outer ? { kind: 'only', alias: read.ref.alias, item: on } : on);
                i = end;
            } else if (this.is(i, 'USING')) {
                throw new UnreadSql('JOIN … USING');
            }
            if (i >= hi) break;
            if (this.punct(i, ',')) {
                outer = false;
                i++;
                continue;
            }
            outer = false;
            while (!this.is(i, 'JOIN', 'STRAIGHT_JOIN')) {
                if (this.is(i, 'LEFT')) outer = true;
                else if (this.is(i, 'RIGHT', 'NATURAL')) throw new UnreadSql(`${this.t[i].upper} JOIN`);
                else if (!this.is(i, 'INNER', 'CROSS', 'OUTER')) throw new UnreadSql('liste de tables illisible');
                i++;
            }
            i++;
        }
        return { refs, conds };
    }

    private table(lo: number, hi: number): { ref: TableRef; next: number } {
        let i = lo;
        let ref: TableRef;
        if (this.punct(i, '(')) {
            if (!this.opensQuery(i)) throw new UnreadSql('jointure entre parenthèses');
            const close = this.end(i);
            ref = { alias: '', table: null, foreign: false, query: this.query(i + 1, close) };
            i = close + 1;
        } else {
            const name = this.t[i];
            if (!name || name.kind !== 'word') throw new UnreadSql('nom de table attendu');
            i++;
            if (this.punct(i, '.')) {
                const inner = this.t[i + 1];
                if (!inner || inner.kind !== 'word') throw new UnreadSql('nom de table attendu');
                ref = { alias: inner.text, table: inner.text, foreign: true, query: null };
                i += 2;
            } else {
                const cte = this.ctes.get(name.text);
                ref = cte
                    ? { alias: name.text, table: null, foreign: false, query: cte }
                    : { alias: name.text, table: name.text, foreign: false, query: null };
            }
        }
        if (this.is(i, 'AS')) i++;
        const alias = this.t[i];
        if (i < hi && alias && alias.kind === 'word' && !AFTER_TABLE.has(alias.upper)) {
            ref.alias = alias.text;
            i++;
        }
        // `USE INDEX (…)`, `FORCE INDEX (…)`, `PARTITION (…)` : rien qui nomme une table.
        while (i < hi && this.is(i, 'USE', 'FORCE', 'IGNORE', 'PARTITION')) {
            while (i < hi && !this.punct(i, '(')) i++;
            i = this.end(i) + 1;
        }
        return { ref, next: i };
    }

    /** Coupe `[lo, hi)` aux mots de premier niveau ; un BETWEEN garde son AND. */
    private split(lo: number, hi: number, word: 'AND' | 'OR'): [number, number][] {
        const parts: [number, number][] = [];
        let from = lo;
        let between = false;
        for (const i of this.top(lo, hi)) {
            if (this.is(i, 'BETWEEN')) between = true;
            else if (word === 'AND' && between && this.is(i, 'AND')) between = false;
            else if (this.is(i, word) || this.punct(i, word === 'AND' ? '&&' : '||')) {
                parts.push([from, i]);
                from = i + 1;
            }
        }
        parts.push([from, hi]);
        return parts;
    }

    private cond(lo: number, hi: number, nested: Query[]): Cond {
        // Un morceau calculé à ce niveau peut commencer par OR : rien ici ne borne plus.
        if (this.dynamic(lo, hi)) {
            this.collect(lo, hi, nested);
            return { kind: 'opaque' };
        }
        const ors = this.split(lo, hi, 'OR');
        if (ors.length > 1) return { kind: 'or', items: ors.map(([a, b]) => this.cond(a, b, nested)) };
        const ands = this.split(lo, hi, 'AND');
        if (ands.length > 1) return { kind: 'and', items: ands.map(([a, b]) => this.cond(a, b, nested)) };
        return this.predicate(lo, hi, nested);
    }

    private subquery(open: number, nested: Query[]): Query {
        const query = this.query(open + 1, this.end(open));
        nested.push(query);
        return query;
    }

    private predicate(lo: number, hi: number, nested: Query[]): Cond {
        if (lo >= hi) return { kind: 'opaque' };
        if (this.is(lo, 'NOT')) {
            // Une négation ne borne rien ; ses sous-requêtes restent à vérifier.
            this.collect(lo + 1, hi, nested);
            return { kind: 'opaque' };
        }
        if (this.punct(lo, '(') && this.end(lo) === hi - 1 && !this.opensQuery(lo)) {
            return this.cond(lo + 1, hi - 1, nested);
        }
        if (this.is(lo, 'EXISTS') && this.punct(lo + 1, '(') && this.end(lo + 1) === hi - 1) {
            return { kind: 'exists', query: this.subquery(lo + 1, nested) };
        }
        const inAt = this.find(lo, hi, 'IN');
        if (inAt > lo && this.punct(inAt + 1, '(') && this.end(inAt + 1) === hi - 1 && !this.is(inAt - 1, 'NOT')) {
            const column = this.column(lo, inAt);
            if (this.opensQuery(inAt + 1)) {
                const query = this.subquery(inAt + 1, nested);
                return column ? { kind: 'in', column, query } : { kind: 'opaque' };
            }
            if (column && this.constant(inAt + 2, hi - 1)) return { kind: 'bound', column, param: null };
        }
        const equals = [...this.top(lo, hi)].filter((i) => this.punct(i, '='));
        if (equals.length === 1) {
            const [at] = equals;
            const left = this.column(lo, at);
            const right = this.column(at + 1, hi);
            if (left && right) return { kind: 'link', left, right };
            const column = left ?? right;
            const [a, b] = left ? [at + 1, hi] : [lo, at];
            if (column && this.punct(a, '(') && this.end(a) === b - 1 && this.opensQuery(a)) {
                return { kind: 'in', column, query: this.subquery(a, nested) };
            }
            if (column && this.constant(a, b)) {
                const only = b - a === 1 ? this.t[a] : undefined;
                return { kind: 'bound', column, param: only?.kind === 'param' ? only.param : null };
            }
        }
        this.collect(lo, hi, nested);
        return { kind: 'opaque' };
    }

    /** `colonne`, `alias.colonne` ou `schéma.table.colonne`, et rien d'autre. */
    private column(lo: number, hi: number): ColumnRef | null {
        const words = [];
        for (let i = lo; i < hi; i++) {
            const tok = this.t[i];
            const dot = (i - lo) % 2 === 1;
            if (dot ? !this.punct(i, '.') : tok.kind !== 'word') return null;
            if (!dot) words.push(tok);
        }
        if (words.length === 0 || words.length > 3 || (hi - lo) % 2 === 0) return null;
        const name = words[words.length - 1];
        if (words.length === 1 && CONSTANT_WORDS.has(name.upper)) return null;
        return { qualifier: words.length > 1 ? words[words.length - 2].text : null, name: name.text };
    }

    /** Une expression sans colonne ni sous-requête : des paramètres, des littéraux, des fonctions d'eux. */
    private constant(lo: number, hi: number): boolean {
        if (lo >= hi) return false;
        for (let i = lo; i < hi; i++) {
            const tok = this.t[i];
            if (tok.kind !== 'word') continue;
            if (tok.upper === 'SELECT') return false;
            if (!this.punct(i + 1, '(') && !CONSTANT_WORDS.has(tok.upper)) return false;
        }
        return true;
    }

    private firstColumn(lo: number, hi: number): ColumnRef | null {
        let from = lo;
        if (this.is(from, 'DISTINCT', 'ALL')) from++;
        let to = hi;
        for (const i of this.top(from, hi)) {
            if (this.punct(i, ',')) {
                to = i;
                break;
            }
        }
        const as = this.find(from, to, 'AS');
        if (as !== -1) to = as;
        else if (to - from === 2 || to - from === 4) to--;
        return this.column(from, to);
    }

    /** Toute sous-requête de `[lo, hi)`, à quelque profondeur de parenthèses que ce soit. */
    private collect(lo: number, hi: number, nested: Query[]): void {
        for (let i = lo; i < hi; i++) {
            if (!this.punct(i, '(')) continue;
            if (this.opensQuery(i)) {
                this.subquery(i, nested);
                i = this.end(i);
            }
        }
    }

    private insert(lo: number, hi: number, ctes: Query[]): Statement {
        let i = lo + 1;
        while (this.is(i, 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE', 'INTO')) i++;
        const name = this.t[i];
        if (!name || name.kind !== 'word' || this.punct(i + 1, '.')) throw new UnreadSql('table d’insertion illisible');
        if (name.text === DYNAMIC_SQL) throw new UnreadSql('table d’insertion calculée');
        i++;
        let columns: string[] | null = null;
        if (this.punct(i, '(') && !this.opensQuery(i)) {
            const close = this.end(i);
            columns = this.t.slice(i + 1, close).flatMap((tok) => (tok.kind === 'word' ? [tok.text] : []));
            if (columns.includes(DYNAMIC_SQL)) throw new UnreadSql('colonnes d’insertion calculées');
            i = close + 1;
        }
        const nested: Query[] = [];
        if (this.is(i, 'SET')) throw new UnreadSql('INSERT … SET');
        let select: Query | null = null;
        if (this.is(i, 'SELECT') || this.punct(i, '(')) {
            let end = hi;
            for (const j of this.top(i, hi)) {
                if (this.is(j, 'ON') && this.is(j + 1, 'DUPLICATE')) {
                    end = j;
                    break;
                }
            }
            select = this.query(i, end);
            this.collect(end, hi, nested);
        } else {
            this.collect(i, hi, nested);
        }
        return { kind: 'insert', table: name.text, columns, select, nested, ctes };
    }

    private update(lo: number, hi: number, ctes: Query[]): Statement {
        let i = lo + 1;
        while (this.is(i, 'LOW_PRIORITY', 'IGNORE')) i++;
        const set = this.find(i, hi, 'SET');
        if (set === -1) throw new UnreadSql('UPDATE sans SET');
        const nested: Query[] = [];
        const { refs, conds } = this.tables(i, set, nested);
        const where = this.find(set + 1, hi, 'WHERE');
        const tail = this.find(where === -1 ? set + 1 : where + 1, hi, 'ORDER', 'LIMIT');
        const end = tail === -1 ? hi : tail;
        this.collect(set + 1, where === -1 ? end : where, nested);
        if (where !== -1) conds.push(this.cond(where + 1, end, nested));
        return { kind: 'write', block: { refs, cond: { kind: 'and', items: conds }, nested, first: null }, ctes };
    }

    private remove(lo: number, hi: number, ctes: Query[]): Statement {
        const from = this.find(lo + 1, hi, 'FROM');
        if (from === -1) throw new UnreadSql('DELETE sans FROM');
        const where = this.find(from + 1, hi, 'WHERE');
        const tail = this.find(where === -1 ? from + 1 : where + 1, hi, 'ORDER', 'LIMIT');
        const end = tail === -1 ? hi : tail;
        const nested: Query[] = [];
        const { refs, conds } = this.tables(from + 1, where === -1 ? end : where, nested);
        if (where !== -1) conds.push(this.cond(where + 1, end, nested));
        return { kind: 'write', block: { refs, cond: { kind: 'and', items: conds }, nested, first: null }, ctes };
    }
}

/** Lève `UnreadSql` sur une tournure qu'il ne sait pas lire. */
export function readSql(sql: string): Statement {
    return new Reader(tokenize(sql)).statement();
}

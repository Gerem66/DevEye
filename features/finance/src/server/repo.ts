import type {
    FinanceAccountBalanceRow,
    FinanceAccountKind,
    FinanceAccountRow,
    FinanceCategoryRow,
    FinanceColor,
    FinanceConfigRow,
    FinanceFlow,
    FinanceFrequency,
    FinanceRecurringRow,
    FinanceTransactionKind,
    FinanceTransactionRow
} from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * Aucun `SELECT *` sur une table à colonne `DATE` : le pilote rendrait un
 * objet `Date` recalé sur le fuseau du processus, d'où les projections
 * `DATE_FORMAT(..., '%Y-%m-%d')`. Chaque requête filtre sur `workspace_id`,
 * même par identifiant.
 */

/** Colonnes d'une opération, la date projetée en `AAAA-MM-JJ`. */
const TX_COLUMNS = `t.id, t.workspace_id, t.account_id, t.transfer_account_id, t.category_id,
    t.recurring_id, t.kind, t.amount, t.vat_amount, DATE_FORMAT(t.date, '%Y-%m-%d') AS date,
    t.cleared, t.content, t.created, t.updated`;

/** Colonnes d'une échéance, les trois dates projetées. */
const REC_COLUMNS = `r.id, r.workspace_id, r.account_id, r.transfer_account_id, r.category_id,
    r.kind, r.amount, r.vat_amount, r.frequency, r.interval_count,
    DATE_FORMAT(r.next_date, '%Y-%m-%d') AS next_date,
    r.anchor_day,
    DATE_FORMAT(r.end_date, '%Y-%m-%d') AS end_date,
    DATE_FORMAT(r.last_posted_date, '%Y-%m-%d') AS last_posted_date,
    r.automatic, r.active, r.content, r.created`;

/**
 * Les mouvements vus depuis le compte qu'ils touchent : un virement apparaît
 * deux fois, une par côté, ce qui permet les trois soldes en une agrégation.
 */
const MOVEMENTS = `
    SELECT account_id AS acc, date, cleared,
           CASE kind WHEN 'income' THEN amount ELSE -amount END AS delta
      FROM finance_transactions
     WHERE workspace_id = ?
    UNION ALL
    SELECT transfer_account_id AS acc, date, cleared, amount AS delta
      FROM finance_transactions
     WHERE workspace_id = ? AND kind = 'transfer' AND transfer_account_id IS NOT NULL`;

export interface FinanceAccountInput {
    kind: FinanceAccountKind;
    color: FinanceColor;
    initialBalance: number;
    archived: boolean;
    content: string;
}

export interface FinanceCategoryInput {
    flow: FinanceFlow;
    color: FinanceColor;
    icon: string;
    content: string;
}

export interface FinanceTransactionInput {
    accountId: number;
    transferAccountId: number | null;
    categoryId: number | null;
    recurringId: number | null;
    kind: FinanceTransactionKind;
    amount: number;
    vatAmount: number | null;
    date: string;
    cleared: boolean;
    content: string;
}

export interface FinanceRecurringInput {
    accountId: number;
    transferAccountId: number | null;
    categoryId: number | null;
    kind: FinanceTransactionKind;
    amount: number;
    vatAmount: number | null;
    frequency: FinanceFrequency;
    interval: number;
    nextDate: string;
    /** Jour d'ancrage, dérivé de `nextDate` par l'appelant. */
    anchorDay: number | null;
    endDate: string | null;
    automatic: boolean;
    active: boolean;
    content: string;
}

/** Filtre du journal. Toutes les bornes sont facultatives et se combinent. */
export interface FinanceTransactionFilter {
    accountId?: number;
    categoryId?: number;
    kind?: FinanceTransactionKind;
    /** Premier jour compris. */
    from?: string;
    /** Dernier jour compris. */
    to?: string;
    cleared?: boolean;
}

/** Une part de la répartition par catégorie, telle que l'agrégation la rend. */
export interface FinanceCategoryShareRow {
    category_id: number | null;
    flow: FinanceFlow;
    amount: number;
    count: number;
}

/** Un mois d'entrées et de sorties. */
export interface FinanceMonthRow {
    month: string;
    income: number;
    expense: number;
}

export interface FinanceRepo {
    getConfig(workspaceId: number): Promise<FinanceConfigRow | null>;
    upsertConfig(workspaceId: number, currency: string, vatEnabled: boolean): Promise<FinanceConfigRow>;

    /**
     * `includeArchived` ne joue que sur la liste, jamais sur les totaux.
     * `today` est passé et non lu par `CURDATE()` : le fuseau de MySQL et celui
     * de Node peuvent différer.
     */
    listAccounts(workspaceId: number, includeArchived: boolean, today: string): Promise<FinanceAccountBalanceRow[]>;
    findAccount(id: number, workspaceId: number, today: string): Promise<FinanceAccountBalanceRow | null>;
    /** Sans les soldes : une lecture par clé, là où {@link findAccount} déroule l'agrégation de tous les mouvements. */
    findAccountPlain(id: number, workspaceId: number): Promise<FinanceAccountRow | null>;
    createAccount(workspaceId: number, input: FinanceAccountInput): Promise<number>;
    updateAccount(id: number, workspaceId: number, input: FinanceAccountInput): Promise<boolean>;
    deleteAccount(id: number, workspaceId: number): Promise<boolean>;
    reorderAccounts(workspaceId: number, accountIds: number[]): Promise<void>;
    /** Combien d'opérations touchent ce compte, des deux côtés d'un virement. */
    countAccountUsage(id: number, workspaceId: number): Promise<number>;
    /** La clé étrangère est en CASCADE : sans ce décompte, supprimer un compte emporterait ses échéances en silence. */
    countAccountRecurring(id: number, workspaceId: number): Promise<number>;

    listCategories(workspaceId: number): Promise<FinanceCategoryRow[]>;
    findCategory(id: number, workspaceId: number): Promise<FinanceCategoryRow | null>;
    createCategory(workspaceId: number, input: FinanceCategoryInput): Promise<number>;
    updateCategory(id: number, workspaceId: number, input: FinanceCategoryInput): Promise<boolean>;
    deleteCategory(id: number, workspaceId: number): Promise<boolean>;

    listTransactions(
        workspaceId: number,
        filter: FinanceTransactionFilter,
        limit: number,
        offset: number
    ): Promise<FinanceTransactionRow[]>;
    countTransactions(workspaceId: number, filter: FinanceTransactionFilter): Promise<number>;
    /** Sommes des entrées et des sorties du filtre, virements exclus. */
    sumTransactions(
        workspaceId: number,
        filter: FinanceTransactionFilter
    ): Promise<{ income: number; expense: number }>;
    findTransaction(id: number, workspaceId: number): Promise<FinanceTransactionRow | null>;
    /** L'occurrence d'une échéance à une date, servie par l'index unique `(recurring_id, date)`. */
    findOccurrence(workspaceId: number, recurringId: number, date: string): Promise<FinanceTransactionRow | null>;
    createTransaction(workspaceId: number, input: FinanceTransactionInput): Promise<number>;
    updateTransaction(id: number, workspaceId: number, input: FinanceTransactionInput): Promise<boolean>;
    deleteTransaction(id: number, workspaceId: number): Promise<boolean>;
    setCleared(workspaceId: number, ids: number[], cleared: boolean): Promise<void>;

    /**
     * Somme des soldes à `today`, archivés compris (archiver ne fait pas
     * disparaître l'argent). `today` en paramètre : le fuseau reste celui du
     * serveur, et la courbe demande un solde à une date passée.
     */
    totalBalance(workspaceId: number, today: string, kinds?: FinanceAccountKind[]): Promise<number>;
    /** La même, en tenant compte des opérations déjà datées plus tard. */
    projectedBalance(workspaceId: number): Promise<number>;
    /** Répartition par catégorie sur `[from, to]`, virements exclus. */
    categoryShares(workspaceId: number, from: string, to: string): Promise<FinanceCategoryShareRow[]>;
    /** Entrées et sorties par mois civil sur `[from, to]`, virements exclus. */
    monthlyFlow(workspaceId: number, from: string, to: string): Promise<FinanceMonthRow[]>;
    /** TVA collectée et déductible sur `[from, to]`. */
    vatTotals(workspaceId: number, from: string, to: string): Promise<{ collected: number; deductible: number }>;

    listRecurring(workspaceId: number): Promise<FinanceRecurringRow[]>;
    /** Les échéances actives dont l'occurrence est due au plus tard à `onOrBefore`. */
    listDueRecurring(workspaceId: number, onOrBefore: string, automatic?: boolean): Promise<FinanceRecurringRow[]>;
    findRecurring(id: number, workspaceId: number): Promise<FinanceRecurringRow | null>;
    createRecurring(workspaceId: number, input: FinanceRecurringInput): Promise<number>;
    updateRecurring(id: number, workspaceId: number, input: FinanceRecurringInput): Promise<boolean>;
    deleteRecurring(id: number, workspaceId: number): Promise<boolean>;
    /** `lastPostedDate` et `active` à `null` laissent la valeur en place. */
    advanceRecurring(
        id: number,
        workspaceId: number,
        nextDate: string,
        lastPostedDate: string | null,
        active: boolean | null
    ): Promise<void>;
}

/** Les fragments sont écrits ici, jamais bâtis depuis une donnée reçue : seules les valeurs voyagent. */
function whereOf(workspaceId: number, f: FinanceTransactionFilter): { sql: string; params: unknown[] } {
    const parts = ['t.workspace_id = ?'];
    const params: unknown[] = [workspaceId];
    if (f.accountId !== undefined) {
        // Des deux côtés : un virement vers ce compte bouge son solde.
        parts.push('(t.account_id = ? OR t.transfer_account_id = ?)');
        params.push(f.accountId, f.accountId);
    }
    if (f.categoryId !== undefined) {
        parts.push('t.category_id = ?');
        params.push(f.categoryId);
    }
    if (f.kind !== undefined) {
        parts.push('t.kind = ?');
        params.push(f.kind);
    }
    if (f.from !== undefined) {
        parts.push('t.date >= ?');
        params.push(f.from);
    }
    if (f.to !== undefined) {
        parts.push('t.date <= ?');
        params.push(f.to);
    }
    if (f.cleared !== undefined) {
        parts.push('t.cleared = ?');
        params.push(f.cleared ? 1 : 0);
    }
    return { sql: parts.join(' AND '), params };
}

/** Rang libre suivant, en bout de liste. */
async function nextRank(q: SdkQueryable, table: 'finance_accounts' | 'finance_categories', workspaceId: number) {
    const rows = await q.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM ${table} WHERE workspace_id = ?`,
        [workspaceId]
    );
    return Number(rows[0]?.next ?? 0);
}

export function createRepo(q: SdkQueryable): FinanceRepo {
    /** Les trois soldes en une passe ; le solde initial est ajouté aux trois. */
    const accountsQuery = (extra: string) => `
        WITH mv AS (${MOVEMENTS})
        SELECT a.id, a.workspace_id, a.kind, a.color, a.initial_balance, a.archived,
               a.sort_order, a.content, a.created,
               a.initial_balance + COALESCE(SUM(CASE WHEN mv.date <= ? THEN mv.delta END), 0) AS balance,
               a.initial_balance + COALESCE(SUM(mv.delta), 0) AS projected,
               a.initial_balance
                 + COALESCE(SUM(CASE WHEN mv.cleared = 1 AND mv.date <= ? THEN mv.delta END), 0) AS cleared,
               COUNT(mv.delta) AS transaction_count
          FROM finance_accounts a
          LEFT JOIN mv ON mv.acc = a.id
         WHERE a.workspace_id = ? ${extra}
         GROUP BY a.id
         ORDER BY a.sort_order ASC, a.id ASC`;

    return {
        async getConfig(workspaceId) {
            const rows = await q.query<FinanceConfigRow>('SELECT * FROM finance_config WHERE workspace_id = ?', [
                workspaceId
            ]);
            return rows[0] ?? null;
        },
        async upsertConfig(workspaceId, currency, vatEnabled) {
            await q.execute(
                `INSERT INTO finance_config (workspace_id, currency, vat_enabled) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE currency = VALUES(currency), vat_enabled = VALUES(vat_enabled)`,
                [workspaceId, currency, vatEnabled ? 1 : 0]
            );
            const rows = await q.query<FinanceConfigRow>('SELECT * FROM finance_config WHERE workspace_id = ?', [
                workspaceId
            ]);
            return rows[0];
        },

        async listAccounts(workspaceId, includeArchived, today) {
            return q.query<FinanceAccountBalanceRow>(accountsQuery(includeArchived ? '' : 'AND a.archived = 0'), [
                workspaceId,
                workspaceId,
                today,
                today,
                workspaceId
            ]);
        },
        async findAccount(id, workspaceId, today) {
            const rows = await q.query<FinanceAccountBalanceRow>(accountsQuery('AND a.id = ?'), [
                workspaceId,
                workspaceId,
                today,
                today,
                workspaceId,
                id
            ]);
            return rows[0] ?? null;
        },
        async findAccountPlain(id, workspaceId) {
            const rows = await q.query<FinanceAccountRow>(
                'SELECT * FROM finance_accounts WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createAccount(workspaceId, input) {
            const sortOrder = await nextRank(q, 'finance_accounts', workspaceId);
            const res = await q.execute(
                `INSERT INTO finance_accounts
                     (workspace_id, kind, color, initial_balance, archived, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.kind,
                    input.color,
                    input.initialBalance,
                    input.archived ? 1 : 0,
                    sortOrder,
                    input.content
                ]
            );
            return res.insertId;
        },
        async updateAccount(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_accounts
                    SET kind = ?, color = ?, initial_balance = ?, archived = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [input.kind, input.color, input.initialBalance, input.archived ? 1 : 0, input.content, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async deleteAccount(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_accounts WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorderAccounts(workspaceId, accountIds) {
            for (let i = 0; i < accountIds.length; i++) {
                await q.execute('UPDATE finance_accounts SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    accountIds[i],
                    workspaceId
                ]);
            }
        },
        async countAccountUsage(id, workspaceId) {
            const rows = await q.query<{ count: number }>(
                `SELECT COUNT(*) AS count FROM finance_transactions
                  WHERE workspace_id = ? AND (account_id = ? OR transfer_account_id = ?)`,
                [workspaceId, id, id]
            );
            return Number(rows[0]?.count ?? 0);
        },

        async countAccountRecurring(id, workspaceId) {
            const rows = await q.query<{ count: number }>(
                `SELECT COUNT(*) AS count FROM finance_recurring
                  WHERE workspace_id = ? AND (account_id = ? OR transfer_account_id = ?)`,
                [workspaceId, id, id]
            );
            return Number(rows[0]?.count ?? 0);
        },
        async listCategories(workspaceId) {
            return q.query<FinanceCategoryRow>(
                `SELECT * FROM finance_categories WHERE workspace_id = ?
                  ORDER BY flow ASC, sort_order ASC, id ASC`,
                [workspaceId]
            );
        },
        async findCategory(id, workspaceId) {
            const rows = await q.query<FinanceCategoryRow>(
                'SELECT * FROM finance_categories WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createCategory(workspaceId, input) {
            const sortOrder = await nextRank(q, 'finance_categories', workspaceId);
            const res = await q.execute(
                `INSERT INTO finance_categories (workspace_id, flow, color, icon, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [workspaceId, input.flow, input.color, input.icon, sortOrder, input.content]
            );
            return res.insertId;
        },
        async updateCategory(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_categories SET flow = ?, color = ?, icon = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [input.flow, input.color, input.icon, input.content, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async deleteCategory(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_categories WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },

        async listTransactions(workspaceId, filter, limit, offset) {
            const { sql, params } = whereOf(workspaceId, filter);
            return q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t
                  WHERE ${sql}
                  ORDER BY t.date DESC, t.id DESC
                  LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
        },
        async countTransactions(workspaceId, filter) {
            const { sql, params } = whereOf(workspaceId, filter);
            const rows = await q.query<{ count: number }>(
                `SELECT COUNT(*) AS count FROM finance_transactions t WHERE ${sql}`,
                params
            );
            return Number(rows[0]?.count ?? 0);
        },
        async sumTransactions(workspaceId, filter) {
            const { sql, params } = whereOf(workspaceId, filter);
            // Les virements sont exclus : déplacer de l'argent n'est ni une recette ni une dépense.
            const rows = await q.query<{ income: number; expense: number }>(
                `SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount END), 0) AS income,
                        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount END), 0) AS expense
                   FROM finance_transactions t WHERE ${sql}`,
                params
            );
            return {
                income: Number(rows[0]?.income ?? 0),
                expense: Number(rows[0]?.expense ?? 0)
            };
        },
        async findTransaction(id, workspaceId) {
            const rows = await q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t WHERE t.id = ? AND t.workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findOccurrence(workspaceId, recurringId, date) {
            const rows = await q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.recurring_id = ? AND t.date = ?`,
                [workspaceId, recurringId, date]
            );
            return rows[0] ?? null;
        },
        async createTransaction(workspaceId, input) {
            const res = await q.execute(
                `INSERT INTO finance_transactions
                     (workspace_id, account_id, transfer_account_id, category_id, recurring_id,
                      kind, amount, vat_amount, date, cleared, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.recurringId,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.date,
                    input.cleared ? 1 : 0,
                    input.content
                ]
            );
            return res.insertId;
        },
        async updateTransaction(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_transactions
                    SET account_id = ?, transfer_account_id = ?, category_id = ?, kind = ?, amount = ?,
                        vat_amount = ?, date = ?, cleared = ?, content = ?, updated = UNIX_TIMESTAMP()
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.date,
                    input.cleared ? 1 : 0,
                    input.content,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows > 0;
        },
        async deleteTransaction(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_transactions WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async setCleared(workspaceId, ids, cleared) {
            if (ids.length === 0) return;
            // Un seul `IN (...)`, dont les marqueurs sont engendrés depuis la
            // **longueur** du tableau et jamais depuis son contenu.
            const marks = ids.map(() => '?').join(', ');
            await q.execute(
                `UPDATE finance_transactions SET cleared = ?, updated = UNIX_TIMESTAMP()
                  WHERE workspace_id = ? AND id IN (${marks})`,
                [cleared ? 1 : 0, workspaceId, ...ids]
            );
        },

        async totalBalance(workspaceId, today, kinds) {
            const kindClause = kinds && kinds.length > 0 ? `AND a.kind IN (${kinds.map(() => '?').join(', ')})` : '';
            // `SUM(a.initial_balance)` sur une jointure dupliquerait le solde
            // initial autant de fois qu'un compte a de mouvements: on agrège
            // donc par compte d'abord, puis on somme les soldes obtenus.
            const rows = await q.query<{ total: number }>(
                `WITH mv AS (${MOVEMENTS}),
                      per_account AS (
                          SELECT a.id,
                                 a.initial_balance
                                   + COALESCE(SUM(CASE WHEN mv.date <= ? THEN mv.delta END), 0) AS balance
                            FROM finance_accounts a
                            LEFT JOIN mv ON mv.acc = a.id
                           WHERE a.workspace_id = ? ${kindClause}
                           GROUP BY a.id
                      )
                 SELECT COALESCE(SUM(balance), 0) AS total FROM per_account`,
                [workspaceId, workspaceId, today, workspaceId, ...(kinds ?? [])]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async projectedBalance(workspaceId) {
            const rows = await q.query<{ total: number }>(
                `WITH mv AS (${MOVEMENTS}),
                      per_account AS (
                          SELECT a.id, a.initial_balance + COALESCE(SUM(mv.delta), 0) AS balance
                            FROM finance_accounts a
                            LEFT JOIN mv ON mv.acc = a.id
                           WHERE a.workspace_id = ?
                           GROUP BY a.id
                      )
                 SELECT COALESCE(SUM(balance), 0) AS total FROM per_account`,
                [workspaceId, workspaceId, workspaceId]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async categoryShares(workspaceId, from, to) {
            const rows = await q.query<FinanceCategoryShareRow>(
                `SELECT t.category_id,
                        CASE WHEN t.kind = 'income' THEN 'income' ELSE 'expense' END AS flow,
                        SUM(t.amount) AS amount, COUNT(*) AS count
                   FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.date >= ? AND t.date <= ? AND t.kind <> 'transfer'
                  GROUP BY t.category_id, flow
                  ORDER BY amount DESC`,
                [workspaceId, from, to]
            );
            return rows.map((row) => ({
                ...row,
                amount: Number(row.amount),
                count: Number(row.count)
            }));
        },
        async monthlyFlow(workspaceId, from, to) {
            const rows = await q.query<FinanceMonthRow>(
                `SELECT DATE_FORMAT(t.date, '%Y-%m') AS month,
                        COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount END), 0) AS income,
                        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount END), 0) AS expense
                   FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.date >= ? AND t.date <= ?
                  GROUP BY month
                  ORDER BY month ASC`,
                [workspaceId, from, to]
            );
            return rows.map((row) => ({
                month: row.month,
                income: Number(row.income),
                expense: Number(row.expense)
            }));
        },
        async vatTotals(workspaceId, from, to) {
            // Collectée sur les recettes, déductible sur les dépenses. Les
            // virements n'en portent pas: rien n'est vendu ni acheté.
            const rows = await q.query<{ collected: number; deductible: number }>(
                `SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.vat_amount END), 0) AS collected,
                        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.vat_amount END), 0) AS deductible
                   FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.date >= ? AND t.date <= ? AND t.vat_amount IS NOT NULL`,
                [workspaceId, from, to]
            );
            return {
                collected: Number(rows[0]?.collected ?? 0),
                deductible: Number(rows[0]?.deductible ?? 0)
            };
        },

        async listRecurring(workspaceId) {
            return q.query<FinanceRecurringRow>(
                `SELECT ${REC_COLUMNS} FROM finance_recurring r WHERE r.workspace_id = ?
                  ORDER BY r.active DESC, r.next_date ASC, r.id ASC`,
                [workspaceId]
            );
        },
        async listDueRecurring(workspaceId, onOrBefore, automatic) {
            const clause = automatic === undefined ? '' : 'AND r.automatic = ?';
            return q.query<FinanceRecurringRow>(
                `SELECT ${REC_COLUMNS} FROM finance_recurring r
                  WHERE r.workspace_id = ? AND r.active = 1 AND r.next_date <= ?
                    AND (r.end_date IS NULL OR r.next_date <= r.end_date) ${clause}
                  ORDER BY r.next_date ASC, r.id ASC`,
                automatic === undefined ? [workspaceId, onOrBefore] : [workspaceId, onOrBefore, automatic ? 1 : 0]
            );
        },
        async findRecurring(id, workspaceId) {
            const rows = await q.query<FinanceRecurringRow>(
                `SELECT ${REC_COLUMNS} FROM finance_recurring r WHERE r.id = ? AND r.workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createRecurring(workspaceId, input) {
            const res = await q.execute(
                `INSERT INTO finance_recurring
                     (workspace_id, account_id, transfer_account_id, category_id, kind, amount, vat_amount,
                      frequency, interval_count, next_date, anchor_day, end_date, automatic, active, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.frequency,
                    input.interval,
                    input.nextDate,
                    input.anchorDay,
                    input.endDate,
                    input.automatic ? 1 : 0,
                    input.active ? 1 : 0,
                    input.content
                ]
            );
            return res.insertId;
        },
        async updateRecurring(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_recurring
                    SET account_id = ?, transfer_account_id = ?, category_id = ?, kind = ?, amount = ?,
                        vat_amount = ?, frequency = ?, interval_count = ?, next_date = ?, anchor_day = ?,
                        end_date = ?, automatic = ?, active = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.frequency,
                    input.interval,
                    input.nextDate,
                    input.anchorDay,
                    input.endDate,
                    input.automatic ? 1 : 0,
                    input.active ? 1 : 0,
                    input.content,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows > 0;
        },
        async deleteRecurring(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_recurring WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async advanceRecurring(id, workspaceId, nextDate, lastPostedDate, active) {
            // `COALESCE` porte ici tout le contrat: un argument à `null` veut
            // dire « ne touche pas », et non « mets NULL ».
            await q.execute(
                `UPDATE finance_recurring
                    SET next_date = ?,
                        last_posted_date = COALESCE(?, last_posted_date),
                        active = COALESCE(?, active)
                  WHERE id = ? AND workspace_id = ?`,
                [nextDate, lastPostedDate, active === null ? null : active ? 1 : 0, id, workspaceId]
            );
        }
    };
}

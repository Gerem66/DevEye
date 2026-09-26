import assert from 'node:assert/strict';
import type { z, ZodType } from 'zod';

import type {
    FinanceAccountBalanceRow,
    FinanceAccountRow,
    FinanceCategoryRow,
    FinanceConfigRow,
    FinanceRecurringRow,
    FinanceTransactionRow
} from '../contracts/domain';

import type { SdkFeatureContext } from '@deveye/types/sdk/server';

import { financeHandlers } from './handlers';
import type { FinanceRepo, FinanceTransactionFilter } from './repo';

/**
 * Le dépôt des tests, en mémoire, partagé par les tests des handlers et ceux de
 * la recopie : les gardes et les index uniques y lèvent comme la base.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
export function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = financeHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<FinanceRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

export interface FakeRepo extends FinanceRepo {
    config: FinanceConfigRow | null;
    accounts: FinanceAccountRow[];
    categories: FinanceCategoryRow[];
    transactions: FinanceTransactionRow[];
    recurring: FinanceRecurringRow[];
}

function matches(t: FinanceTransactionRow, f: FinanceTransactionFilter): boolean {
    if (f.accountId !== undefined && t.account_id !== f.accountId && t.transfer_account_id !== f.accountId) {
        return false;
    }
    if (f.categoryId !== undefined && t.category_id !== f.categoryId) return false;
    if (f.kind !== undefined && t.kind !== f.kind) return false;
    if (f.from !== undefined && t.date < f.from) return false;
    if (f.to !== undefined && t.date > f.to) return false;
    if (f.cleared !== undefined && (t.cleared === 1) !== f.cleared) return false;
    return true;
}

/**
 * Dépôt en mémoire, tableaux mutés en place. L'index unique `(recurring_id,
 * date)` est rejoué en levant `ER_DUP_ENTRY` : c'est le contrat de l'idempotence.
 */
export function fakeRepo(): FakeRepo {
    let seq = 0;
    const now = () => Math.floor(Date.now() / 1000);
    const delta = (t: FinanceTransactionRow, accountId: number): number => {
        if (t.account_id === accountId) return t.kind === 'income' ? t.amount : -t.amount;
        if (t.kind === 'transfer' && t.transfer_account_id === accountId) return t.amount;
        return 0;
    };
    const withBalances = (a: FinanceAccountRow, ws: number, day: string): FinanceAccountBalanceRow => {
        const mine = repo.transactions.filter((t) => t.workspace_id === ws && delta(t, a.id) !== 0);
        const sum = (rows: FinanceTransactionRow[]) => rows.reduce((s, t) => s + delta(t, a.id), 0);
        return {
            ...a,
            balance: a.initial_balance + sum(mine.filter((t) => t.date <= day)),
            projected: a.initial_balance + sum(mine),
            cleared: a.initial_balance + sum(mine.filter((t) => t.cleared === 1 && t.date <= day)),
            transaction_count: mine.length
        };
    };
    const repo: FakeRepo = {
        config: null,
        accounts: [],
        categories: [],
        transactions: [],
        recurring: [],

        async getConfig(ws) {
            return this.config?.workspace_id === ws ? this.config : null;
        },
        async setInvoicingLink(ws, accountId, categoryId) {
            this.config = {
                workspace_id: ws,
                invoicing_account_id: accountId,
                invoicing_category_id: categoryId,
                invoicing_version: null
            };
        },
        async setInvoicingVersion(ws, version) {
            if (this.config?.workspace_id === ws) this.config.invoicing_version = version;
        },

        async listAccounts(ws, includeArchived, day) {
            return this.accounts
                .filter((a) => a.workspace_id === ws && (includeArchived || a.archived === 0))
                .map((a) => withBalances(a, ws, day));
        },
        async findAccount(id, ws, day) {
            const a = await this.findAccountPlain(id, ws);
            return a ? withBalances(a, ws, day) : null;
        },
        async findAccountPlain(id, ws) {
            return this.accounts.find((a) => a.id === id && a.workspace_id === ws) ?? null;
        },
        async createAccount(ws, input) {
            const row: FinanceAccountRow = {
                id: ++seq,
                workspace_id: ws,
                kind: input.kind,
                color: input.color,
                initial_balance: input.initialBalance,
                opened_on: input.openedOn,
                archived: input.archived ? 1 : 0,
                sort_order: this.accounts.length,
                content: input.content,
                created: now()
            };
            this.accounts.push(row);
            return row.id;
        },
        async updateAccount(id, ws, input) {
            const row = await this.findAccountPlain(id, ws);
            if (!row) return false;
            Object.assign(row, {
                kind: input.kind,
                color: input.color,
                initial_balance: input.initialBalance,
                opened_on: input.openedOn,
                archived: input.archived ? 1 : 0,
                content: input.content
            });
            return true;
        },
        async deleteAccount(id, ws) {
            const i = this.accounts.findIndex((a) => a.id === id && a.workspace_id === ws);
            if (i === -1) return false;
            this.accounts.splice(i, 1);
            return true;
        },
        async reorderAccounts(ws, ids) {
            ids.forEach((id, i) => {
                const row = this.accounts.find((a) => a.id === id && a.workspace_id === ws);
                if (row) row.sort_order = i;
            });
        },
        async countAccountUsage(id, ws) {
            return this.transactions.filter(
                (t) => t.workspace_id === ws && (t.account_id === id || t.transfer_account_id === id)
            ).length;
        },
        async countAccountRecurring(id, ws) {
            return this.recurring.filter(
                (r) => r.workspace_id === ws && (r.account_id === id || r.transfer_account_id === id)
            ).length;
        },

        async listCategories(ws) {
            return this.categories.filter((c) => c.workspace_id === ws);
        },
        async findCategory(id, ws) {
            return this.categories.find((c) => c.id === id && c.workspace_id === ws) ?? null;
        },
        async createCategory(ws, input) {
            const row: FinanceCategoryRow = {
                id: ++seq,
                workspace_id: ws,
                flow: input.flow,
                color: input.color,
                icon: input.icon,
                sort_order: this.categories.length,
                content: input.content,
                created: now()
            };
            this.categories.push(row);
            return row.id;
        },
        async updateCategory(id, ws, input) {
            const row = await this.findCategory(id, ws);
            if (!row) return false;
            Object.assign(row, { flow: input.flow, color: input.color, icon: input.icon, content: input.content });
            return true;
        },
        async deleteCategory(id, ws) {
            const i = this.categories.findIndex((c) => c.id === id && c.workspace_id === ws);
            if (i === -1) return false;
            this.categories.splice(i, 1);
            return true;
        },

        async listTransactions(ws, filter, limit, offset) {
            return this.transactions
                .filter((t) => t.workspace_id === ws && matches(t, filter))
                .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1))
                .slice(offset, offset + limit);
        },
        async countTransactions(ws, filter) {
            return this.transactions.filter((t) => t.workspace_id === ws && matches(t, filter)).length;
        },
        async sumTransactions(ws, filter) {
            const rows = this.transactions.filter((t) => t.workspace_id === ws && matches(t, filter));
            return {
                income: rows.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0),
                expense: rows.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount, 0)
            };
        },
        async findTransaction(id, ws) {
            return this.transactions.find((t) => t.id === id && t.workspace_id === ws) ?? null;
        },
        async findOccurrence(ws, recurringId, date) {
            return (
                this.transactions.find(
                    (t) => t.workspace_id === ws && t.recurring_id === recurringId && t.date === date
                ) ?? null
            );
        },
        async createTransaction(ws, input) {
            const sourceTaken =
                input.source !== null &&
                this.transactions.some(
                    (t) => t.workspace_id === ws && t.source === input.source && t.source_ref === input.sourceRef
                );
            if (
                sourceTaken ||
                (input.recurringId !== null && (await this.findOccurrence(ws, input.recurringId, input.date)))
            ) {
                throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
            }
            const row: FinanceTransactionRow = {
                id: ++seq,
                workspace_id: ws,
                account_id: input.accountId,
                transfer_account_id: input.transferAccountId,
                category_id: input.categoryId,
                recurring_id: input.recurringId,
                source: input.source,
                source_ref: input.sourceRef,
                kind: input.kind,
                amount: input.amount,
                vat_amount: input.vatAmount,
                date: input.date,
                cleared: input.cleared ? 1 : 0,
                content: input.content,
                created: now(),
                updated: now()
            };
            this.transactions.push(row);
            return row.id;
        },
        async listSourced(ws, source) {
            return this.transactions
                .filter((t) => t.workspace_id === ws && t.source === source)
                .map((t) => ({
                    id: t.id,
                    account_id: t.account_id,
                    source_ref: t.source_ref ?? '',
                    amount: t.amount,
                    vat_amount: t.vat_amount,
                    date: t.date
                }));
        },
        async updateSourcedFacts(id, ws, facts) {
            const row = await this.findTransaction(id, ws);
            if (row) Object.assign(row, { amount: facts.amount, vat_amount: facts.vatAmount, date: facts.date });
        },
        async listAdoptable(ws, accountId, amount, from, to) {
            return this.transactions.filter(
                (t) =>
                    t.workspace_id === ws &&
                    t.account_id === accountId &&
                    t.kind === 'income' &&
                    t.amount === amount &&
                    t.date >= from &&
                    t.date <= to &&
                    t.source === null &&
                    t.recurring_id === null
            );
        },
        async adopt(id, ws, source, sourceRef, content) {
            const row = await this.findTransaction(id, ws);
            if (row && row.source === null) Object.assign(row, { source, source_ref: sourceRef, content });
        },
        async updateTransaction(id, ws, input) {
            const row = await this.findTransaction(id, ws);
            if (!row) return false;
            Object.assign(row, {
                account_id: input.accountId,
                transfer_account_id: input.transferAccountId,
                category_id: input.categoryId,
                kind: input.kind,
                amount: input.amount,
                vat_amount: input.vatAmount,
                date: input.date,
                cleared: input.cleared ? 1 : 0,
                content: input.content,
                updated: now()
            });
            return true;
        },
        async deleteTransaction(id, ws) {
            const i = this.transactions.findIndex((t) => t.id === id && t.workspace_id === ws);
            if (i === -1) return false;
            this.transactions.splice(i, 1);
            return true;
        },
        async setCleared(ws, ids, cleared) {
            for (const t of this.transactions) {
                if (t.workspace_id === ws && ids.includes(t.id)) t.cleared = cleared ? 1 : 0;
            }
        },

        async totalBalance(ws, day, kinds) {
            const rows = await this.listAccounts(ws, true, day);
            return rows.filter((a) => !kinds || kinds.includes(a.kind)).reduce((s, a) => s + a.balance, 0);
        },
        async projectedBalance(ws) {
            const rows = await this.listAccounts(ws, true, '9999-12-31');
            return rows.reduce((s, a) => s + a.projected, 0);
        },
        async categoryShares() {
            return [];
        },
        async monthlyFlow() {
            return [];
        },
        async vatTotals() {
            return { collected: 0, deductible: 0 };
        },

        async listRecurring(ws) {
            return this.recurring.filter((r) => r.workspace_id === ws);
        },
        async listDueRecurring(ws, onOrBefore, automatic) {
            return this.recurring.filter(
                (r) =>
                    r.workspace_id === ws &&
                    r.active === 1 &&
                    r.next_date <= onOrBefore &&
                    (r.end_date === null || r.next_date <= r.end_date) &&
                    (automatic === undefined || (r.automatic === 1) === automatic)
            );
        },
        async findRecurring(id, ws) {
            return this.recurring.find((r) => r.id === id && r.workspace_id === ws) ?? null;
        },
        async createRecurring(ws, input) {
            const row: FinanceRecurringRow = {
                id: ++seq,
                workspace_id: ws,
                account_id: input.accountId,
                transfer_account_id: input.transferAccountId,
                category_id: input.categoryId,
                kind: input.kind,
                amount: input.amount,
                vat_amount: input.vatAmount,
                frequency: input.frequency,
                interval_count: input.interval,
                next_date: input.nextDate,
                anchor_day: input.anchorDay,
                end_date: input.endDate,
                last_posted_date: null,
                automatic: input.automatic ? 1 : 0,
                active: input.active ? 1 : 0,
                content: input.content,
                created: now()
            };
            this.recurring.push(row);
            return row.id;
        },
        async updateRecurring(id, ws, input) {
            const row = await this.findRecurring(id, ws);
            if (!row) return false;
            Object.assign(row, {
                account_id: input.accountId,
                transfer_account_id: input.transferAccountId,
                category_id: input.categoryId,
                kind: input.kind,
                amount: input.amount,
                vat_amount: input.vatAmount,
                frequency: input.frequency,
                interval_count: input.interval,
                next_date: input.nextDate,
                anchor_day: input.anchorDay,
                end_date: input.endDate,
                automatic: input.automatic ? 1 : 0,
                active: input.active ? 1 : 0,
                content: input.content
            });
            return true;
        },
        async deleteRecurring(id, ws) {
            const i = this.recurring.findIndex((r) => r.id === id && r.workspace_id === ws);
            if (i === -1) return false;
            this.recurring.splice(i, 1);
            return true;
        },
        async advanceRecurring(id, ws, nextDate, lastPostedDate, active) {
            const row = await this.findRecurring(id, ws);
            if (!row) return;
            row.next_date = nextDate;
            if (lastPostedDate !== null) row.last_posted_date = lastPostedDate;
            if (active !== null) row.active = active ? 1 : 0;
        }
    };
    return repo;
}

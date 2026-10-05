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
import type { FinanceBankLinkRow, FinanceConnectionRow } from '../contracts/banking';
import type { FinanceRuleRow, FinanceStatementLineRow } from '../contracts/statement';

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
    /** Les rappels retenus, `espace/période/étape`. */
    reminders: string[];
    imports: {
        id: number;
        workspace_id: number;
        account_id: number;
        line_count: number;
        new_count: number;
        closing_balance: number | null;
        closing_date: string | null;
    }[];
    lines: FinanceStatementLineRow[];
    rules: FinanceRuleRow[];
    connections: FinanceConnectionRow[];
    links: FinanceBankLinkRow[];
}

/** Une ligne de réglages vierge : ce que la base rend avant tout réglage. */
function blankConfig(ws: number): FinanceConfigRow {
    return {
        workspace_id: ws,
        invoicing_account_id: null,
        invoicing_category_id: null,
        invoicing_version: null,
        legal_status: null,
        micro_activity: null,
        provision_rate_bp: null,
        income_tax_prepaid: 0,
        declaration_period: null,
        tracking_since: null
    };
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
    const roleOf = (categoryId: number | null) =>
        categoryId === null ? null : (repo.categories.find((c) => c.id === categoryId)?.role ?? null);
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
        reminders: [],
        imports: [],
        lines: [],
        rules: [],
        connections: [],
        links: [],

        async getConfig(ws) {
            return this.config?.workspace_id === ws ? this.config : null;
        },
        async setInvoicingLink(ws, accountId, categoryId) {
            this.config = {
                ...(this.config?.workspace_id === ws ? this.config : blankConfig(ws)),
                invoicing_account_id: accountId,
                invoicing_category_id: categoryId,
                invoicing_version: null
            };
        },
        async setStatus(ws, status) {
            this.config = {
                ...(this.config?.workspace_id === ws ? this.config : blankConfig(ws)),
                legal_status: status.legalStatus as FinanceConfigRow['legal_status'],
                micro_activity: status.microActivity as FinanceConfigRow['micro_activity'],
                provision_rate_bp: status.provisionRateBp,
                income_tax_prepaid: status.incomeTaxPrepaid ? 1 : 0,
                declaration_period: status.declarationPeriod as FinanceConfigRow['declaration_period'],
                tracking_since: status.trackingSince
            };
        },
        async listDeclaring() {
            const c = this.config;
            if (!c || c.legal_status !== 'micro' || !c.micro_activity || !c.declaration_period) return [];
            return [
                {
                    workspace_id: c.workspace_id,
                    micro_activity: c.micro_activity,
                    declaration_period: c.declaration_period,
                    provision_rate_bp: c.provision_rate_bp,
                    income_tax_prepaid: c.income_tax_prepaid
                }
            ];
        },
        async markReminder(ws, periodKey, stage) {
            const key = `${ws}/${periodKey}/${stage}`;
            if (this.reminders.includes(key)) return false;
            this.reminders.push(key);
            return true;
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
            this.lines = this.lines.filter((line) => line.account_id !== id);
            this.links = this.links.filter((link) => link.account_id !== id);
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
                role: input.role,
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
            Object.assign(row, {
                flow: input.flow,
                color: input.color,
                icon: input.icon,
                role: input.role,
                content: input.content
            });
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
            for (const line of this.lines) if (line.transaction_id === id) line.transaction_id = null;
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
        async monthlyFlow(ws, from, to) {
            const months = new Map<string, { month: string; income: number; expense: number }>();
            for (const t of this.transactions) {
                if (t.workspace_id !== ws || t.date < from || t.date > to || t.kind === 'transfer') continue;
                const month = t.date.slice(0, 7);
                const entry = months.get(month) ?? { month, income: 0, expense: 0 };
                if (t.kind === 'income') entry.income += t.amount;
                else entry.expense += t.amount;
                months.set(month, entry);
            }
            return [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
        },
        async vatTotals(ws, from, to) {
            const rows = this.transactions.filter(
                (t) => t.workspace_id === ws && t.date >= from && t.date <= to && t.vat_amount !== null
            );
            return {
                collected: rows.filter((t) => t.kind === 'income').reduce((s, t) => s + (t.vat_amount ?? 0), 0),
                deductible: rows.filter((t) => t.kind === 'expense').reduce((s, t) => s + (t.vat_amount ?? 0), 0)
            };
        },
        async revenueBetween(ws, from, to) {
            return this.transactions
                .filter((t) => t.workspace_id === ws && t.kind === 'income' && t.date >= from && t.date <= to)
                .filter((t) => roleOf(t.category_id) !== 'other')
                .reduce((s, t) => s + t.amount - (t.vat_amount ?? 0), 0);
        },
        async chargesBetween(ws, from, to) {
            return this.transactions
                .filter((t) => t.workspace_id === ws && t.kind === 'expense' && t.date >= from && t.date <= to)
                .filter((t) => roleOf(t.category_id) === null)
                .reduce((s, t) => s + t.amount - (t.vat_amount ?? 0), 0);
        },
        async paidByRoles(ws, roles, from, to) {
            return this.transactions
                .filter((t) => t.workspace_id === ws && t.kind === 'expense' && t.date >= from && t.date <= to)
                .filter((t) => {
                    const role = roleOf(t.category_id);
                    return role !== null && roles.includes(role);
                })
                .reduce((s, t) => s + t.amount, 0);
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
        },

        async createImport(ws, input) {
            const id = ++seq;
            this.imports.push({
                id,
                workspace_id: ws,
                account_id: input.accountId,
                line_count: input.lineCount,
                new_count: input.newCount,
                closing_balance: input.closingBalance,
                closing_date: input.closingDate
            });
            return id;
        },
        async setImportCounts(id, ws, lineCount, newCount) {
            const row = this.imports.find((i) => i.id === id && i.workspace_id === ws);
            if (row) Object.assign(row, { line_count: lineCount, new_count: newCount });
        },
        async latestClosings(ws) {
            const rows = this.imports
                .filter((i) => i.workspace_id === ws && i.closing_balance !== null && i.closing_date !== null)
                .sort((a, b) =>
                    a.closing_date === b.closing_date ? b.id - a.id : a.closing_date! < b.closing_date! ? 1 : -1
                );
            const seen = new Set<number>();
            return rows
                .filter((row) => !seen.has(row.account_id) && seen.add(row.account_id))
                .map((row) => ({
                    account_id: row.account_id,
                    closing_balance: row.closing_balance!,
                    closing_date: row.closing_date!
                }));
        },
        async insertLine(ws, input) {
            if (this.lines.some((l) => l.account_id === input.accountId && l.external_id === input.externalId))
                return null;
            const row: FinanceStatementLineRow = {
                id: ++seq,
                workspace_id: ws,
                account_id: input.accountId,
                import_id: input.importId,
                external_id: input.externalId,
                date: input.date,
                direction: input.direction,
                amount: input.amount,
                transaction_id: null,
                ignored: 0,
                content: input.content
            };
            this.lines.push(row);
            return row.id;
        },
        async findLines(ws, ids) {
            return this.lines.filter((l) => l.workspace_id === ws && ids.includes(l.id));
        },
        async listLines(ws, filter, limit) {
            const open = (l: FinanceStatementLineRow) => l.transaction_id === null && l.ignored === 0;
            return this.lines
                .filter(
                    (l) =>
                        l.workspace_id === ws &&
                        (!filter.pendingOnly || open(l)) &&
                        (filter.accountId === undefined || l.account_id === filter.accountId)
                )
                .sort((a, b) =>
                    open(a) !== open(b)
                        ? open(a)
                            ? -1
                            : 1
                        : a.date === b.date
                          ? b.id - a.id
                          : a.date < b.date
                            ? 1
                            : -1
                )
                .slice(0, limit);
        },
        async countPendingLines(ws, accountId) {
            return this.lines.filter(
                (l) =>
                    l.workspace_id === ws &&
                    l.transaction_id === null &&
                    l.ignored === 0 &&
                    (accountId === undefined || l.account_id === accountId)
            ).length;
        },
        async linkLine(id, ws, transactionId) {
            const row = this.lines.find((l) => l.id === id && l.workspace_id === ws);
            if (!row) return;
            if (
                transactionId !== null &&
                this.lines.some(
                    (l) => l.id !== id && l.transaction_id === transactionId && l.account_id === row.account_id
                )
            ) {
                throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
            }
            row.transaction_id = transactionId;
        },
        async setLineIgnored(ids, ws, ignored) {
            for (const l of this.lines) {
                if (l.workspace_id === ws && l.transaction_id === null && ids.includes(l.id))
                    l.ignored = ignored ? 1 : 0;
            }
        },
        async unconfirmedTransactions(ws, accountId, from, to) {
            return this.transactions
                .filter(
                    (t) =>
                        t.workspace_id === ws &&
                        (t.account_id === accountId || t.transfer_account_id === accountId) &&
                        t.date >= from &&
                        t.date <= to &&
                        !this.lines.some((l) => l.transaction_id === t.id && l.account_id === accountId)
                )
                .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
        },
        async linkedLines(ws, transactionId) {
            return this.lines.filter((l) => l.workspace_id === ws && l.transaction_id === transactionId);
        },
        async releaseLines(transactionId, ws) {
            for (const l of this.lines) {
                if (l.workspace_id === ws && l.transaction_id === transactionId) {
                    l.transaction_id = null;
                    l.ignored = 1;
                }
            }
        },
        async countAccountLines(id, ws) {
            return this.lines.filter((l) => l.workspace_id === ws && l.account_id === id).length;
        },
        async listRules(ws) {
            return this.rules
                .filter((r) => r.workspace_id === ws)
                .sort((a, b) => (a.sort_order === b.sort_order ? a.id - b.id : a.sort_order - b.sort_order));
        },
        async findRule(id, ws) {
            return this.rules.find((r) => r.id === id && r.workspace_id === ws) ?? null;
        },
        async createRule(ws, input) {
            const mine = this.rules.filter((r) => r.workspace_id === ws);
            const row: FinanceRuleRow = {
                id: ++seq,
                workspace_id: ws,
                direction: input.direction,
                category_id: input.categoryId,
                vat_rate_bp: input.vatRateBp,
                sort_order: mine.length === 0 ? 0 : Math.max(...mine.map((r) => r.sort_order)) + 1,
                hits: 0,
                content: input.content
            };
            this.rules.push(row);
            return row.id;
        },
        async updateRule(id, ws, input) {
            const row = await this.findRule(id, ws);
            if (!row) return false;
            Object.assign(row, {
                direction: input.direction,
                category_id: input.categoryId,
                vat_rate_bp: input.vatRateBp,
                content: input.content
            });
            return true;
        },
        async deleteRule(id, ws) {
            const i = this.rules.findIndex((r) => r.id === id && r.workspace_id === ws);
            if (i === -1) return false;
            this.rules.splice(i, 1);
            return true;
        },
        async bumpRuleHits(id, ws, by) {
            const row = await this.findRule(id, ws);
            if (row) row.hits += by;
        },

        async listConnections(ws) {
            return this.connections.filter((c) => c.workspace_id === ws);
        },
        async findConnection(id, ws) {
            return this.connections.find((c) => c.id === id && c.workspace_id === ws) ?? null;
        },
        async createConnection(ws, input) {
            const row: FinanceConnectionRow = {
                id: ++seq,
                workspace_id: ws,
                provider: input.provider,
                status: 'ok',
                error: null,
                valid_until: input.validUntil,
                warned_until: null,
                last_sync_at: null,
                content: input.content,
                created: now()
            };
            this.connections.push(row);
            return row.id;
        },
        async setConnectionContent(id, ws, content) {
            const row = await this.findConnection(id, ws);
            if (!row) return false;
            row.content = content;
            return true;
        },
        async replaceConnection(id, ws, input) {
            const row = await this.findConnection(id, ws);
            if (!row) return false;
            Object.assign(row, { content: input.content, valid_until: input.validUntil, status: 'ok', error: null });
            return true;
        },
        async recordSync(id, ws, at, status, error) {
            const row = await this.findConnection(id, ws);
            if (row) Object.assign(row, { last_sync_at: at, status, error });
        },
        async deleteConnection(id, ws) {
            const i = this.connections.findIndex((c) => c.id === id && c.workspace_id === ws);
            if (i === -1) return false;
            this.connections.splice(i, 1);
            this.links = this.links.filter((link) => link.connection_id !== id);
            return true;
        },
        async countConnectionsInWorkspaces(ids) {
            return this.connections.filter((c) => ids.includes(c.workspace_id)).length;
        },
        async countProviderConnections(provider) {
            const of = this.connections.filter((c) => c.provider === provider);
            return { total: of.length, failing: of.filter((c) => c.status !== 'ok').length };
        },
        async listStockConnections(ids) {
            return this.connections
                .filter((c) => ids.includes(c.workspace_id))
                .map((c) => ({ id: String(c.id), workspaceId: c.workspace_id }));
        },
        async listDueConnections(before, pausedIds, limit) {
            return this.connections
                .filter(
                    (c) =>
                        c.status !== 'expired' &&
                        (c.last_sync_at === null || c.last_sync_at < before) &&
                        !pausedIds.includes(c.id)
                )
                .slice(0, limit);
        },
        async listExpiringConnections(before) {
            return this.connections.filter(
                (c) => c.valid_until !== null && c.valid_until < before && c.status !== 'expired'
            );
        },
        async claimExpiryWarning(id, ws) {
            const row = await this.findConnection(id, ws);
            if (!row || row.valid_until === null || row.warned_until === row.valid_until) return false;
            row.warned_until = row.valid_until;
            return true;
        },
        async markExpired(id, ws) {
            const row = await this.findConnection(id, ws);
            if (!row || row.status === 'expired') return false;
            row.status = 'expired';
            return true;
        },
        async listBankLinks(ws) {
            return this.links.filter((link) => link.workspace_id === ws);
        },
        async listConnectionLinks(connectionId, ws) {
            return this.links.filter((link) => link.connection_id === connectionId && link.workspace_id === ws);
        },
        async setBankLink(accountId, ws, link) {
            this.links = this.links.filter((entry) => !(entry.account_id === accountId && entry.workspace_id === ws));
            if (link === null) return;
            if (
                this.links.some(
                    (entry) =>
                        entry.connection_id === link.connectionId &&
                        entry.external_account_id === link.externalAccountId
                )
            ) {
                throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
            }
            this.links.push({
                account_id: accountId,
                workspace_id: ws,
                connection_id: link.connectionId,
                external_account_id: link.externalAccountId,
                since: link.since
            });
        },
        async latestLineDate(accountId, ws) {
            const dates = this.lines
                .filter((l) => l.account_id === accountId && l.workspace_id === ws)
                .map((l) => l.date)
                .sort();
            return dates[dates.length - 1] ?? null;
        }
    };
    return repo;
}

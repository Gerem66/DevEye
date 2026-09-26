import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    financeAccountAdd,
    financeAccountList,
    financeAccountRemove,
    financeCategoryAdd,
    financeConfig,
    financeConfigUpdate,
    financeRecurringAdd,
    financeRecurringPost,
    financeTransactionAdd,
    financeTransactionList
} from '../contracts/commands';
import type {
    FinanceAccountBalanceRow,
    FinanceAccountRow,
    FinanceCategoryRow,
    FinanceConfigRow,
    FinanceRecurringRow,
    FinanceTransactionRow
} from '../contracts/domain';
import type { SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { addMonths, today } from './_shared';
import { financeHandlers } from './handlers';
import type { FinanceRepo, FinanceTransactionFilter } from './repo';

/** Les gardes du livre et le rattrapage des échéances : rien de tout cela ne lève ailleurs. */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = financeHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<FinanceRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

interface FakeRepo extends FinanceRepo {
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
function fakeRepo(): FakeRepo {
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
        async upsertConfig(ws, currency, vatEnabled) {
            this.config = { workspace_id: ws, currency, vat_enabled: vatEnabled ? 1 : 0 };
            return this.config;
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
            if (input.recurringId !== null && (await this.findOccurrence(ws, input.recurringId, input.date))) {
                throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
            }
            const row: FinanceTransactionRow = {
                id: ++seq,
                workspace_id: ws,
                account_id: input.accountId,
                transfer_account_id: input.transferAccountId,
                category_id: input.categoryId,
                recurring_id: input.recurringId,
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

/** Un compte courant posé d'office, pour les scénarios qui en ont besoin. */
async function seedAccount(ctx: SdkFeatureContext<FinanceRepo>, name = 'Courant', initialBalance = 10_000) {
    const out = await handlerFor(financeAccountAdd)(ctx, {
        account: { name, kind: 'checking', color: 'blue', initialBalance, note: '', archived: false }
    });
    return out.account;
}

describe('finance.config', () => {
    it('rend les valeurs par défaut sans rien écrire, puis ce qui a été réglé', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });

        const initial = await handlerFor(financeConfig)(ctx, {});
        assert.deepEqual(initial.config, { currency: 'EUR', vatEnabled: false });
        // Une lecture n'insère jamais la ligne : un membre en lecture seule
        // ne doit pas modifier la base en ouvrant un écran.
        assert.equal(repo.config === null, true);

        const updated = await handlerFor(financeConfigUpdate)(ctx, { config: { currency: 'CHF', vatEnabled: true } });
        assert.deepEqual(updated.config, { currency: 'CHF', vatEnabled: true });
        assert.equal(repo.config?.currency, 'CHF');
        assert.equal(ctx.recorded.audits.length, 1);
        assert.equal(ctx.recorded.audits[0].action, 'finance.configUpdate');

        const reread = await handlerFor(financeConfig)(ctx, {});
        assert.deepEqual(reread.config, { currency: 'CHF', vatEnabled: true });
    });
});

describe('finance.accountAdd / finance.accountList', () => {
    it('chiffre le texte libre et rend le compte avec ses soldes', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });

        const created = await seedAccount(ctx, 'Livret A', 250_000);
        assert.equal(created.name, 'Livret A');
        assert.equal(created.balance, 250_000);
        assert.equal(created.transactionCount, 0);
        // Le harnais chiffre à l'identité : le nom doit être passé par le
        // cipher, en JSON, jamais posé en clair dans une colonne à part.
        assert.deepEqual(JSON.parse(repo.accounts[0].content), { name: 'Livret A', note: '' });

        const listed = await handlerFor(financeAccountList)(ctx, {});
        assert.equal(listed.accounts.length, 1);
        assert.equal(listed.accounts[0].name, 'Livret A');
        assert.equal(listed.accounts[0].balance, 250_000);
    });

    it('refuse de supprimer un compte qui porte des opérations, et le dit', async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        const account = await seedAccount(ctx);
        await handlerFor(financeTransactionAdd)(ctx, {
            transaction: {
                accountId: account.id,
                kind: 'expense',
                amount: 1_250,
                date: today(),
                label: 'Courses',
                categoryId: null,
                transferAccountId: null,
                counterparty: '',
                note: '',
                vatAmount: null,
                cleared: false
            }
        });
        await assert.rejects(handlerFor(financeAccountRemove)(ctx, { accountId: account.id }), /1 opération/);
    });
});

describe("la cohérence d'une saisie", () => {
    it('refuse un virement sans compte de destination', async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        const account = await seedAccount(ctx);
        await assert.rejects(
            handlerFor(financeTransactionAdd)(ctx, {
                transaction: {
                    accountId: account.id,
                    kind: 'transfer',
                    amount: 500,
                    date: today(),
                    label: '',
                    categoryId: null,
                    transferAccountId: null,
                    counterparty: '',
                    note: '',
                    vatAmount: null,
                    cleared: false
                }
            }),
            /compte de destination/
        );
    });

    it('refuse une catégorie du mauvais sens', async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        const account = await seedAccount(ctx);
        const salary = await handlerFor(financeCategoryAdd)(ctx, {
            category: { name: 'Salaire', flow: 'income', color: 'green', icon: 'finance' }
        });
        await assert.rejects(
            handlerFor(financeTransactionAdd)(ctx, {
                transaction: {
                    accountId: account.id,
                    kind: 'expense',
                    amount: 500,
                    date: today(),
                    label: '',
                    categoryId: salary.category.id,
                    transferAccountId: null,
                    counterparty: '',
                    note: '',
                    vatAmount: null,
                    cleared: false
                }
            }),
            /recettes/
        );
    });

    it('refuse une saisie sur un compte inconnu', async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        await assert.rejects(
            handlerFor(financeTransactionAdd)(ctx, {
                transaction: {
                    accountId: 999,
                    kind: 'expense',
                    amount: 500,
                    date: today(),
                    label: '',
                    categoryId: null,
                    transferAccountId: null,
                    counterparty: '',
                    note: '',
                    vatAmount: null,
                    cleared: false
                }
            }),
            /introuvable/i
        );
    });
});

describe('le rattrapage des échéances', () => {
    it("écrit les occurrences dues d'une automatique à la première lecture, une fois chacune", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const account = await seedAccount(ctx);

        // Une échéance mensuelle posée deux mois en arrière : trois occurrences
        // sont dues (il y a deux mois, il y a un mois, ce mois-ci).
        const now = today();
        const firstDate = addMonths(now, -2, null);
        await handlerFor(financeRecurringAdd)(ctx, {
            recurring: {
                accountId: account.id,
                kind: 'expense',
                amount: 80_000,
                label: 'Loyer',
                categoryId: null,
                transferAccountId: null,
                counterparty: 'Agence',
                note: '',
                vatAmount: null,
                frequency: 'monthly',
                interval: 1,
                nextDate: firstDate,
                endDate: null,
                automatic: true,
                active: true
            }
        });
        assert.equal(repo.transactions.length, 0);

        const listed = await handlerFor(financeAccountList)(ctx, {});
        assert.equal(repo.transactions.length, 3);
        assert.equal(listed.accounts[0].balance, 10_000 - 3 * 80_000);
        // Toutes rattachées à l'échéance, jamais pointées, et l'échéance a
        // avancé au-delà d'aujourd'hui.
        assert.ok(repo.transactions.every((t) => t.recurring_id !== null && t.cleared === 0));
        assert.ok(repo.recurring[0].next_date > now);
        assert.equal(repo.recurring[0].last_posted_date, repo.transactions[2].date);

        // Une seconde lecture ne réécrit rien : il n'y a plus rien de dû.
        await handlerFor(financeTransactionList)(ctx, {});
        assert.equal(repo.transactions.length, 3);
    });

    it("n'écrit pas une manuelle : elle attend son clic, puis refuse le doublon", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const account = await seedAccount(ctx);
        const added = await handlerFor(financeRecurringAdd)(ctx, {
            recurring: {
                accountId: account.id,
                kind: 'expense',
                amount: 6_000,
                label: 'Électricité',
                categoryId: null,
                transferAccountId: null,
                counterparty: '',
                note: '',
                vatAmount: null,
                frequency: 'monthly',
                interval: 1,
                nextDate: addMonths(today(), -1, null),
                endDate: null,
                automatic: false,
                active: true
            }
        });

        await handlerFor(financeAccountList)(ctx, {});
        assert.equal(repo.transactions.length, 0);

        // Le clic : le montant corrigé au passage, la date avancée.
        const posted = await handlerFor(financeRecurringPost)(ctx, { recurringId: added.recurring.id, amount: 6_450 });
        assert.equal(posted.transaction.amount, 6_450);
        assert.equal(posted.transaction.date, added.recurring.nextDate);
        assert.equal(posted.recurring.lastPostedDate, added.recurring.nextDate);
        assert.equal(repo.transactions.length, 1);
    });

    it('garde le taux de TVA du modèle quand le montant est corrigé', async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        const account = await seedAccount(ctx);
        // 120 € TTC dont 20 € de TVA : 20 %.
        const added = await handlerFor(financeRecurringAdd)(ctx, {
            recurring: {
                accountId: account.id,
                kind: 'expense',
                amount: 12_000,
                label: 'Serveur',
                categoryId: null,
                transferAccountId: null,
                counterparty: '',
                note: '',
                vatAmount: 2_000,
                frequency: 'monthly',
                interval: 1,
                nextDate: today(),
                endDate: null,
                automatic: false,
                active: true
            }
        });

        const posted = await handlerFor(financeRecurringPost)(ctx, { recurringId: added.recurring.id, amount: 6_000 });
        assert.equal(posted.transaction.amount, 6_000);
        assert.equal(posted.transaction.vatAmount, 1_000);
    });
});

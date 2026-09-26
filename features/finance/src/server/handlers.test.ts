import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    financeAccountAdd,
    financeAccountList,
    financeAccountRemove,
    financeCategoryAdd,
    financeConfig,
    financeRecurringAdd,
    financeRecurringPost,
    financeTransactionAdd,
    financeTransactionList
} from '../contracts/commands';
import { INVOICING_LEDGER_PROVIDER } from '@deveye/types/sdk';
import type { SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { addMonths, today } from './_shared';
import { fakeRepo, handlerFor } from './_testing';
import type { FinanceRepo } from './repo';

/** Les gardes du livre et le rattrapage des échéances : rien de tout cela ne lève ailleurs. */

/** Un compte courant posé d'office, pour les scénarios qui en ont besoin. */
async function seedAccount(ctx: SdkFeatureContext<FinanceRepo>, name = 'Courant', initialBalance = 10_000) {
    const out = await handlerFor(financeAccountAdd)(ctx, {
        account: { name, kind: 'checking', color: 'blue', initialBalance, note: '', archived: false }
    });
    return out.account;
}

describe('finance.config', () => {
    it('sans Facturation : euros, sans TVA, et rien n’est écrit', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });

        const initial = await handlerFor(financeConfig)(ctx, {});
        assert.deepEqual(initial.config, {
            currency: 'EUR',
            vatEnabled: false,
            invoicing: { available: false, accountId: null, categoryId: null },
            status: {
                legalStatus: null,
                microActivity: null,
                provisionRateBp: null,
                incomeTaxPrepaid: false,
                declarationPeriod: null,
                trackingSince: null
            }
        });
        // Une lecture n'insère jamais la ligne : un membre en lecture seule
        // ne doit pas modifier la base en ouvrant un écran.
        assert.equal(repo.config === null, true);
    });

    it('suit la devise et le régime de TVA de Facturation', async () => {
        const ctx = createTestContext({
            repo: fakeRepo(),
            providers: {
                [INVOICING_LEDGER_PROVIDER]: { profile: async () => ({ currency: 'CHF', vatRegime: 'standard' }) }
            }
        });
        const read = await handlerFor(financeConfig)(ctx, {});
        assert.equal(read.config.currency, 'CHF');
        assert.equal(read.config.vatEnabled, true);
        assert.equal(read.config.invoicing.available, true);
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
            category: { name: 'Salaire', flow: 'income', color: 'green', icon: 'finance', role: null }
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

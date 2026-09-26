import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    INVOICING_LEDGER_PROVIDER,
    type InvoicingLedgerPayment,
    type InvoicingLedgerProvider,
    type InvoicingLedgerReceivable
} from '@deveye/types/sdk';
import { createTestContext } from '@deveye/types/sdk/testing';

import {
    financeAccountAdd,
    financeCategoryAdd,
    financeInvoicingLink,
    financeOverview,
    financeTransactionAdd,
    financeTransactionList,
    financeTransactionRemove,
    financeTransactionUpdate
} from '../contracts/commands';
import { addDays, addMonths, startOfMonth, today } from './_shared';
import { fakeRepo, handlerFor, type FakeRepo } from './_testing';
import { syncInvoicing } from './sources';

/**
 * La recopie des règlements de Facturation. Ce qu'elle promet : chaque
 * règlement une fois et une seule, rien d'antérieur au solde de départ, une
 * copie qui suit son original, et un coût nul tant que rien ne bouge.
 */

const DAY = today();

/** Un livre de Facturation en mémoire, qui compte ce qu'on lui demande. */
function fakeLedger(currency = 'EUR') {
    const state = {
        payments: [] as InvoicingLedgerPayment[],
        receivables: [] as InvoicingLedgerReceivable[],
        calls: { version: 0, payments: 0, clientNames: 0 }
    };
    const ledger: InvoicingLedgerProvider = {
        async version() {
            state.calls.version += 1;
            return `${state.payments.length}:${Math.max(0, ...state.payments.map((p) => p.paymentId))}`;
        },
        async payments(_ws, from) {
            state.calls.payments += 1;
            return state.payments.filter((p) => from === null || p.paidOn >= from);
        },
        async clientNames(_ws, docIds) {
            state.calls.clientNames += 1;
            return new Map(docIds.map((id) => [id, `Client ${id}`]));
        },
        async receivables() {
            return state.receivables;
        },
        async profile() {
            return { currency, vatRegime: 'standard' as const };
        }
    };
    return { ledger, state };
}

function payment(id: number, amount: number, paidOn = DAY, over: Partial<InvoicingLedgerPayment> = {}) {
    return {
        paymentId: id,
        docId: 100 + id,
        paidOn,
        amountCents: amount,
        vatCents: Math.round(amount / 6),
        method: 'transfer' as const,
        currency: 'EUR',
        docNumber: `F2026-00${id}`,
        segment: `doc-${100 + id}`,
        ...over
    };
}

/** Un espace, un compte ouvert il y a dix jours, et Facturation reliée. */
async function linked(currency = 'EUR') {
    const repo = fakeRepo();
    const { ledger, state } = fakeLedger(currency);
    const ctx = createTestContext({ repo, providers: { [INVOICING_LEDGER_PROVIDER]: ledger } });
    const { account } = await handlerFor(financeAccountAdd)(ctx, {
        account: {
            name: 'Compte pro',
            kind: 'checking',
            color: 'blue',
            initialBalance: 0,
            openedOn: addDays(DAY, -10),
            note: '',
            archived: false
        }
    });
    const { config } = await handlerFor(financeInvoicingLink)(ctx, { accountId: account.id, categoryId: null });
    return { repo, ctx, state, account, config };
}

const sourced = (repo: FakeRepo) => repo.transactions.filter((t) => t.source === 'invoicing');

describe('la recopie des règlements de Facturation', () => {
    it('ne demande rien à Facturation tant qu’aucun compte ne reçoit', async () => {
        const repo = fakeRepo();
        const { ledger, state } = fakeLedger();
        const ctx = createTestContext({ repo, providers: { [INVOICING_LEDGER_PROVIDER]: ledger } });
        state.payments.push(payment(1, 12_000));
        await syncInvoicing(ctx);
        assert.equal(state.calls.version, 0);
        assert.equal(repo.transactions.length, 0);
    });

    it('recopie chaque règlement une fois, rangé dans « Prestations », avec sa facture', async () => {
        const { repo, ctx, state, account, config } = await linked();
        state.payments.push(payment(1, 12_000), payment(2, 6_000, addDays(DAY, -2)));

        const list = await handlerFor(financeTransactionList)(ctx, {});
        assert.equal(list.transactions.length, 2);
        const copy = list.transactions.find((t) => t.amount === 12_000);
        assert.ok(copy);
        assert.equal(copy.kind, 'income');
        assert.equal(copy.accountId, account.id);
        assert.equal(copy.categoryId, config.invoicing.categoryId);
        assert.equal(copy.vatAmount, 2_000);
        assert.equal(copy.label, 'Facture F2026-001');
        assert.equal(copy.counterparty, 'Client 101');
        assert.deepEqual(copy.origin, { docNumber: 'F2026-001', segment: 'doc-101' });
        assert.equal(repo.categories.length, 1, '« Prestations » a été créée');

        await handlerFor(financeTransactionList)(ctx, {});
        assert.equal(sourced(repo).length, 2, 'la seconde lecture ne double rien');
    });

    it('ne compare plus rien tant que Facturation ne bouge pas', async () => {
        const { ctx, state } = await linked();
        state.payments.push(payment(1, 12_000));
        await syncInvoicing(ctx);
        const before = state.calls.payments;
        await syncInvoicing(ctx);
        await syncInvoicing(ctx);
        assert.equal(state.calls.payments, before);
    });

    it('laisse ce qui précède le solde de départ, déjà compté par lui', async () => {
        const { repo, ctx, state } = await linked();
        state.payments.push(payment(1, 5_000, addDays(DAY, -30)), payment(2, 7_000));
        await syncInvoicing(ctx);
        assert.deepEqual(
            sourced(repo).map((t) => t.amount),
            [7_000]
        );
    });

    it('retire la copie d’un règlement retiré de Facturation', async () => {
        const { repo, ctx, state } = await linked();
        state.payments.push(payment(1, 12_000), payment(2, 6_000));
        await syncInvoicing(ctx);
        state.payments.splice(0, 1);
        await syncInvoicing(ctx);
        assert.deepEqual(
            sourced(repo).map((t) => t.source_ref),
            ['2']
        );
    });

    it('laisse dans Facturation un règlement dans une autre devise', async () => {
        const { repo, ctx, state } = await linked();
        state.payments.push(payment(1, 12_000, DAY, { currency: 'USD' }));
        await syncInvoicing(ctx);
        assert.equal(sourced(repo).length, 0);
    });

    it('ne double rien quand deux lectures recopient en même temps', async () => {
        const { repo, ctx, state } = await linked();
        state.payments.push(payment(1, 12_000));
        await Promise.all([syncInvoicing(ctx), syncInvoicing(ctx)]);
        assert.equal(sourced(repo).length, 1);
    });

    it('reconnaît une recette déjà saisie à la main, si elle est seule candidate', async () => {
        const { repo, ctx, state, account } = await linked();
        // Saisie avant que Facturation ne soit consultée : la liaison a déjà eu lieu,
        // mais aucune lecture n'a encore recopié.
        await handlerFor(financeTransactionAdd)(ctx, {
            transaction: {
                accountId: account.id,
                kind: 'income',
                amount: 12_000,
                date: addDays(DAY, -1),
                label: 'Virement Dupont',
                categoryId: null,
                transferAccountId: null,
                counterparty: 'Dupont',
                note: 'noté à la main',
                vatAmount: null,
                cleared: true
            }
        });
        state.payments.push(payment(1, 12_000));
        await syncInvoicing(ctx);

        assert.equal(repo.transactions.length, 1, 'adoptée, pas doublée');
        const [row] = repo.transactions;
        assert.equal(row.source, 'invoicing');
        assert.equal(row.date, DAY, 'la date de Facturation fait foi');
        assert.equal(row.cleared, 1, 'le pointage reste');
    });

    it('ne devine pas entre deux saisies du même montant', async () => {
        const { repo, ctx, state, account } = await linked();
        for (const date of [DAY, addDays(DAY, -1)]) {
            await handlerFor(financeTransactionAdd)(ctx, {
                transaction: {
                    accountId: account.id,
                    kind: 'income',
                    amount: 12_000,
                    date,
                    label: '',
                    categoryId: null,
                    transferAccountId: null,
                    counterparty: '',
                    note: '',
                    vatAmount: null,
                    cleared: false
                }
            });
        }
        state.payments.push(payment(1, 12_000));
        await syncInvoicing(ctx);
        assert.equal(repo.transactions.length, 3);
    });

    it('se lit sans erreur quand Facturation n’est pas là', async () => {
        const ctx = createTestContext({ repo: fakeRepo() });
        await syncInvoicing(ctx);
        const list = await handlerFor(financeTransactionList)(ctx, {});
        assert.equal(list.transactions.length, 0);
    });
});

describe('les gardes d’une copie de règlement', () => {
    async function copied() {
        const setup = await linked();
        setup.state.payments.push(payment(1, 12_000));
        const list = await handlerFor(financeTransactionList)(setup.ctx, {});
        const [copy] = list.transactions;
        const draft = {
            accountId: copy.accountId,
            kind: copy.kind,
            amount: copy.amount,
            date: copy.date,
            label: copy.label,
            categoryId: copy.categoryId,
            transferAccountId: null,
            counterparty: copy.counterparty,
            note: copy.note,
            vatAmount: copy.vatAmount,
            cleared: copy.cleared
        };
        return { ...setup, copy, draft };
    }

    it('laisse changer la catégorie, la note et le pointage', async () => {
        const { ctx, copy, draft } = await copied();
        const { category } = await handlerFor(financeCategoryAdd)(ctx, {
            category: { name: 'Ventes', flow: 'income', color: 'indigo', icon: 'activity' }
        });
        const out = await handlerFor(financeTransactionUpdate)(ctx, {
            transactionId: copy.id,
            transaction: { ...draft, categoryId: category.id, note: 'acompte', cleared: true }
        });
        assert.equal(out.transaction.categoryId, category.id);
        assert.equal(out.transaction.note, 'acompte');
        assert.deepEqual(out.transaction.origin, copy.origin, 'elle reste une copie');
    });

    it('refuse de changer ses faits, qui se corrigent dans Facturation', async () => {
        const { ctx, copy, draft } = await copied();
        await assert.rejects(
            handlerFor(financeTransactionUpdate)(ctx, {
                transactionId: copy.id,
                transaction: { ...draft, amount: 11_000 }
            }),
            /Facturation/
        );
    });

    it('refuse de la supprimer ici', async () => {
        const { ctx, copy } = await copied();
        await assert.rejects(handlerFor(financeTransactionRemove)(ctx, { transactionId: copy.id }), /Facturation/);
    });
});

describe('le lien avec Facturation', () => {
    it('refuse un compte archivé et une catégorie de dépenses', async () => {
        const repo = fakeRepo();
        const { ledger } = fakeLedger();
        const ctx = createTestContext({ repo, providers: { [INVOICING_LEDGER_PROVIDER]: ledger } });
        const { account } = await handlerFor(financeAccountAdd)(ctx, {
            account: { name: 'Ancien', kind: 'checking', color: 'blue', initialBalance: 0, note: '', archived: true }
        });
        await assert.rejects(
            handlerFor(financeInvoicingLink)(ctx, { accountId: account.id, categoryId: null }),
            /archivé/
        );

        repo.accounts[0].archived = 0;
        const { category } = await handlerFor(financeCategoryAdd)(ctx, {
            category: { name: 'Hébergement', flow: 'expense', color: 'blue', icon: 'cloud' }
        });
        await assert.rejects(
            handlerFor(financeInvoicingLink)(ctx, { accountId: account.id, categoryId: category.id }),
            /recettes/
        );
    });

    it('reprend « Prestations » quand elle existe déjà', async () => {
        const repo = fakeRepo();
        const { ledger } = fakeLedger();
        const ctx = createTestContext({ repo, providers: { [INVOICING_LEDGER_PROVIDER]: ledger } });
        const { account } = await handlerFor(financeAccountAdd)(ctx, {
            account: { name: 'Pro', kind: 'checking', color: 'blue', initialBalance: 0, note: '', archived: false }
        });
        const { category } = await handlerFor(financeCategoryAdd)(ctx, {
            category: { name: 'prestations', flow: 'income', color: 'green', icon: 'server' }
        });
        const { config } = await handlerFor(financeInvoicingLink)(ctx, { accountId: account.id, categoryId: null });
        assert.equal(config.invoicing.categoryId, category.id);
        assert.equal(repo.categories.length, 1);
    });
});

describe('ce qui reste à encaisser, et la prévision', () => {
    it('somme les créances et les place au mois de leur échéance, les retards tout de suite', async () => {
        const { ctx, state } = await linked();
        const nextMonth = addMonths(startOfMonth(DAY), 1, 1);
        state.receivables.push(
            {
                docId: 1,
                docNumber: 'F-1',
                clientName: 'Dupont',
                currency: 'EUR',
                issuedOn: addDays(DAY, -40),
                dueOn: addDays(DAY, -10),
                remainingCents: 30_000,
                remainingVatCents: 5_000,
                overdue: true,
                segment: 'doc-1'
            },
            {
                docId: 2,
                docNumber: 'F-2',
                clientName: 'Martin',
                currency: 'EUR',
                issuedOn: DAY,
                dueOn: addDays(nextMonth, 4),
                remainingCents: 50_000,
                remainingVatCents: 0,
                overdue: false,
                segment: 'doc-2'
            },
            {
                docId: 3,
                docNumber: 'F-3',
                clientName: 'Ailleurs',
                currency: 'USD',
                issuedOn: DAY,
                dueOn: DAY,
                remainingCents: 99_000,
                remainingVatCents: 0,
                overdue: false,
                segment: 'doc-3'
            }
        );

        const { overview } = await handlerFor(financeOverview)(ctx, { range: 'month' });
        assert.ok(overview.receivables);
        assert.equal(overview.receivables.total, 80_000, 'la facture en dollars reste à part');
        assert.equal(overview.receivables.overdue, 30_000);
        assert.equal(overview.receivables.overdueCount, 1);
        assert.equal(overview.receivables.items[0].docNumber, 'F-1');

        const [thisMonth, next] = overview.forecast;
        assert.equal(thisMonth.incoming, 30_000);
        assert.equal(next.incoming, 50_000);
        assert.equal(next.balance, overview.netBalance + 80_000);
    });
});

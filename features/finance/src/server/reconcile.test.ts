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
    financeAccountRemove,
    financeCategoryAdd,
    financeInvoicingLink,
    financeRecurringAdd,
    financeRuleSave,
    financeStatementImport,
    financeStatementList,
    financeStatementResolve,
    financeTransactionAdd,
    financeTransactionRemove,
    financeTransactionUpdate
} from '../contracts/commands';
import type { StatementLineInput } from '../contracts/statement';
import { addDays, today } from './_shared';
import { fakeRepo, handlerFor, type FakeRepo } from './_testing';

/**
 * Le rapprochement des relevés. Ce qu'il promet : une ligne de banque n'entre
 * qu'une fois, elle ne se rattache d'office qu'à une opération sans rivale, et
 * l'ordre d'arrivée (relevé d'abord, règlement ensuite, ou l'inverse) ne change
 * rien au résultat.
 */

const DAY = today();

function line(amount: number, label: string, over: Partial<StatementLineInput> = {}): StatementLineInput {
    return { date: DAY, direction: 'out', amount, label, memo: '', fitid: null, ...over };
}

function ledgerOf(vatRegime: 'standard' | 'exempt' = 'standard') {
    const state = { payments: [] as InvoicingLedgerPayment[], receivables: [] as InvoicingLedgerReceivable[] };
    const ledger: InvoicingLedgerProvider = {
        async version() {
            return String(state.payments.length);
        },
        async payments() {
            return state.payments;
        },
        async clientNames(_ws, docIds) {
            return new Map(docIds.map((id) => [id, `Client ${id}`]));
        },
        async receivables() {
            return state.receivables;
        },
        async profile() {
            return { currency: 'EUR', vatRegime };
        }
    };
    return { ledger, state };
}

async function book(vatRegime: 'standard' | 'exempt' = 'standard') {
    const repo = fakeRepo();
    const { ledger, state } = ledgerOf(vatRegime);
    const ctx = createTestContext({ repo, providers: { [INVOICING_LEDGER_PROVIDER]: ledger } });
    const open = async (name: string) =>
        (
            await handlerFor(financeAccountAdd)(ctx, {
                account: {
                    name,
                    kind: 'checking',
                    color: 'blue',
                    initialBalance: 0,
                    openedOn: addDays(DAY, -60),
                    note: '',
                    archived: false
                }
            })
        ).account;
    const account = await open('Compte pro');
    const hosting = (
        await handlerFor(financeCategoryAdd)(ctx, {
            category: { name: 'Hébergement', flow: 'expense', color: 'blue', icon: 'finance', role: null }
        })
    ).category;
    return { repo, ctx, state, account, hosting, open };
}

type Book = Awaited<ReturnType<typeof book>>;

function importLines(b: Book, lines: StatementLineInput[], accountId = b.account.id) {
    return handlerFor(financeStatementImport)(b.ctx, {
        accountId,
        format: lines.some((l) => l.fitid !== null) ? 'ofx' : 'csv',
        lines,
        closing: null,
        mapping: null
    });
}

function expense(b: Book, amount: number, date: string, label = 'Saisie') {
    return handlerFor(financeTransactionAdd)(b.ctx, {
        transaction: {
            accountId: b.account.id,
            kind: 'expense',
            amount,
            date,
            label,
            categoryId: null,
            transferAccountId: null,
            counterparty: '',
            note: '',
            vatAmount: null,
            cleared: false
        }
    });
}

const pending = (repo: FakeRepo) => repo.lines.filter((l) => l.transaction_id === null && l.ignored === 0);

describe('l’import d’un relevé', () => {
    it('n’ajoute rien au second import du même fichier', async () => {
        const b = await book();
        const lines = [line(1_200, 'PRLV OVH'), line(900, 'CB CAFE')];
        const first = await importLines(b, lines);
        assert.equal(first.result.added, 2);
        const second = await importLines(b, lines);
        assert.equal(second.result.added, 0);
        assert.equal(second.result.duplicates, 2);
        assert.equal(b.repo.lines.length, 2);
    });

    it('garde deux lignes identiques d’un même fichier, et les reconnaît au suivant', async () => {
        const b = await book();
        const lines = [line(350, 'CB CAFE'), line(350, 'CB  Café')];
        assert.equal((await importLines(b, lines)).result.added, 2);
        assert.equal((await importLines(b, lines)).result.added, 0);
    });

    it('reconnaît une ligne d’OFX à son identifiant, même libellé changé', async () => {
        const b = await book();
        await importLines(b, [line(1_200, 'PRLV OVH', { fitid: 'A1' })]);
        const again = await importLines(b, [line(1_200, 'Prélèvement OVH SAS', { fitid: 'A1' })]);
        assert.equal(again.result.added, 0);
    });

    it('propose le solde de départ sur un compte vide, jamais ensuite', async () => {
        const b = await book();
        const run = (accountId: number) =>
            handlerFor(financeStatementImport)(b.ctx, {
                accountId,
                format: 'csv',
                lines: [
                    line(1_000, 'PRLV', { date: addDays(DAY, -3) }),
                    line(5_000, 'VIR CLIENT', { direction: 'in' })
                ],
                closing: { balance: 104_000, date: DAY },
                mapping: null
            });
        const first = await run(b.account.id);
        assert.deepEqual(first.result.opening, { balance: 100_000, date: addDays(DAY, -3) });
        await expense(b, 100, DAY);
        const other = await b.open('Autre');
        await expense({ ...b, account: other }, 100, DAY);
        const second = await run(other.id);
        assert.equal(second.result.opening, null);
    });

    it('refuse de supprimer un compte qui porte un relevé', async () => {
        const b = await book();
        await importLines(b, [line(1_200, 'PRLV OVH')]);
        b.repo.lines[0].ignored = 1;
        await assert.rejects(handlerFor(financeAccountRemove)(b.ctx, { accountId: b.account.id }), /relevé/);
    });
});

describe('le rapprochement', () => {
    it('rattache une ligne à la seule opération qui lui ressemble, et la pointe', async () => {
        const b = await book();
        const { transaction } = await expense(b, 4_990, addDays(DAY, -2));
        const { result } = await importLines(b, [line(4_990, 'CB LDLC')]);
        assert.equal(result.matched, 1);
        assert.equal(b.repo.lines[0].transaction_id, transaction.id);
        assert.equal(b.repo.transactions[0].cleared, 1);
    });

    it('ne tranche pas entre deux candidates : il les propose', async () => {
        const b = await book();
        await expense(b, 2_000, addDays(DAY, -1), 'Train');
        await expense(b, 2_000, DAY, 'Taxi');
        const { result } = await importLines(b, [line(2_000, 'SNCF')]);
        assert.equal(result.matched, 0);
        const list = await handlerFor(financeStatementList)(b.ctx, { status: 'pending' });
        assert.equal(list.lines[0].proposals.filter((p) => p.kind === 'transaction').length, 2);
    });

    it('ignore une opération hors de la fenêtre', async () => {
        const b = await book();
        await expense(b, 2_000, addDays(DAY, -10));
        assert.equal((await importLines(b, [line(2_000, 'SNCF')])).result.matched, 0);
    });

    it('rattache la ligne quand l’opération est saisie après l’import', async () => {
        const b = await book();
        await importLines(b, [line(2_000, 'SNCF')]);
        await expense(b, 2_000, DAY);
        assert.equal(pending(b.repo).length, 0);
    });

    it('arrive au même point, règlement de Facturation d’abord ou relevé d’abord', async () => {
        const payment = (id: number): InvoicingLedgerPayment => ({
            paymentId: id,
            docId: 10 + id,
            paidOn: DAY,
            amountCents: 60_000,
            vatCents: 10_000,
            method: 'transfer',
            currency: 'EUR',
            docNumber: `F-${id}`,
            segment: `doc-${10 + id}`
        });
        const incoming = [line(60_000, 'VIR ACME', { direction: 'in' })];

        const before = await book();
        await handlerFor(financeInvoicingLink)(before.ctx, { accountId: before.account.id, categoryId: null });
        before.state.payments.push(payment(1));
        await importLines(before, incoming);

        const after = await book();
        await handlerFor(financeInvoicingLink)(after.ctx, { accountId: after.account.id, categoryId: null });
        await importLines(after, incoming);
        after.state.payments.push(payment(1));
        await handlerFor(financeStatementList)(after.ctx, { status: 'pending' });

        for (const b of [before, after]) {
            assert.equal(pending(b.repo).length, 0);
            const copy = b.repo.transactions.find((t) => t.source === 'invoicing');
            assert.ok(copy);
            assert.equal(b.repo.lines[0].transaction_id, copy.id);
            assert.equal(copy.cleared, 1);
        }
    });

    it('propose la facture qui attend ce montant, sur le compte qui reçoit seulement', async () => {
        const b = await book();
        await handlerFor(financeInvoicingLink)(b.ctx, { accountId: b.account.id, categoryId: null });
        const other = await b.open('Épargne');
        b.state.receivables.push({
            docId: 7,
            docNumber: 'F-7',
            clientName: 'Acme',
            segment: 'doc-7',
            currency: 'EUR',
            issuedOn: addDays(DAY, -20),
            dueOn: DAY,
            remainingCents: 24_000,
            remainingVatCents: 4_000,
            overdue: false
        });
        await importLines(b, [line(24_000, 'VIR ACME', { direction: 'in' })]);
        await importLines(b, [line(24_000, 'VIR ACME', { direction: 'in' })], other.id);
        const { lines } = await handlerFor(financeStatementList)(b.ctx, { status: 'pending' });
        const proposalsOf = (accountId: number) => lines.find((l) => l.accountId === accountId)?.proposals ?? [];
        assert.deepEqual(
            proposalsOf(b.account.id).map((p) => p.kind),
            ['invoice']
        );
        assert.equal(proposalsOf(other.id).length, 0);
    });

    it('défait le rapprochement quand l’opération ne ressemble plus à sa ligne', async () => {
        const b = await book();
        const { transaction } = await expense(b, 4_990, DAY);
        await importLines(b, [line(4_990, 'CB LDLC')]);
        await handlerFor(financeTransactionUpdate)(b.ctx, {
            transactionId: transaction.id,
            transaction: {
                accountId: b.account.id,
                kind: 'expense',
                amount: 5_990,
                date: DAY,
                label: 'Saisie',
                categoryId: null,
                transferAccountId: null,
                counterparty: '',
                note: '',
                vatAmount: null,
                cleared: true
            }
        });
        assert.equal(pending(b.repo).length, 1);
    });

    it('écarte la ligne d’une opération supprimée, sans la remettre à rapprocher', async () => {
        const b = await book();
        const { transaction } = await expense(b, 4_990, DAY);
        await importLines(b, [line(4_990, 'CB LDLC')]);
        await handlerFor(financeTransactionRemove)(b.ctx, { transactionId: transaction.id });
        assert.equal(b.repo.lines[0].transaction_id, null);
        assert.equal(b.repo.lines[0].ignored, 1);
    });
});

describe('les gestes sur une ligne', () => {
    it('inscrit des lignes et retient la règle, qui range aussitôt les suivantes', async () => {
        const b = await book();
        await importLines(b, [
            line(1_200, 'PRLV SEPA OVH SAS', { date: addDays(DAY, -30) }),
            line(1_200, 'PRLV SEPA OVH SAS'),
            line(900, 'CB CAFE')
        ]);
        const [first] = b.repo.lines;
        const { resolved, pending: left } = await handlerFor(financeStatementResolve)(b.ctx, {
            lineIds: [first.id],
            action: {
                kind: 'create',
                categoryId: b.hosting.id,
                label: null,
                counterparty: 'OVH',
                vatRateBp: 2_000,
                rule: { contains: 'ovh' }
            }
        });
        assert.equal(resolved, 1);
        assert.equal(left, 1);
        const created = b.repo.transactions.filter((t) => t.category_id === b.hosting.id);
        assert.equal(created.length, 2);
        assert.ok(created.every((t) => t.cleared === 1 && t.vat_amount === 200));
        assert.equal(b.repo.rules[0].hits, 1);

        await importLines(b, [line(1_200, 'PRLV SEPA OVH SAS', { date: addDays(DAY, 30) })]);
        assert.equal(b.repo.rules[0].hits, 2);
    });

    it('ne compte pas de TVA en franchise', async () => {
        const b = await book('exempt');
        await importLines(b, [line(1_200, 'PRLV OVH')]);
        await handlerFor(financeStatementResolve)(b.ctx, {
            lineIds: [b.repo.lines[0].id],
            action: {
                kind: 'create',
                categoryId: b.hosting.id,
                label: null,
                counterparty: '',
                vatRateBp: 2_000,
                rule: null
            }
        });
        assert.equal(b.repo.transactions[0].vat_amount, null);
    });

    it('refuse une catégorie de recettes pour une ligne qui sort', async () => {
        const b = await book();
        const sales = (
            await handlerFor(financeCategoryAdd)(b.ctx, {
                category: { name: 'Ventes', flow: 'income', color: 'green', icon: 'finance', role: null }
            })
        ).category;
        await importLines(b, [line(1_200, 'PRLV OVH')]);
        await assert.rejects(
            handlerFor(financeStatementResolve)(b.ctx, {
                lineIds: [b.repo.lines[0].id],
                action: {
                    kind: 'create',
                    categoryId: sales.id,
                    label: null,
                    counterparty: '',
                    vatRateBp: null,
                    rule: null
                }
            }),
            /dépenses/
        );
        assert.equal(b.repo.transactions.length, 0);
    });

    it('fait d’une ligne un virement, et l’autre relevé en confirme l’autre moitié', async () => {
        const b = await book();
        const savings = await b.open('Épargne');
        await importLines(b, [line(50_000, 'VIR VERS LIVRET')]);
        await handlerFor(financeStatementResolve)(b.ctx, {
            lineIds: [b.repo.lines[0].id],
            action: { kind: 'transfer', accountId: savings.id }
        });
        const transfer = b.repo.transactions[0];
        assert.equal(transfer.kind, 'transfer');
        assert.equal(transfer.account_id, b.account.id);
        assert.equal(transfer.transfer_account_id, savings.id);

        await importLines(b, [line(50_000, 'VIR DEPUIS COMPTE', { direction: 'in' })], savings.id);
        assert.equal(pending(b.repo).length, 0);
        assert.equal(b.repo.lines[1].transaction_id, transfer.id);
    });

    it('enregistre l’échéance manuelle proposée, au montant de la banque', async () => {
        const b = await book();
        const { recurring } = await handlerFor(financeRecurringAdd)(b.ctx, {
            recurring: {
                accountId: b.account.id,
                kind: 'expense',
                amount: 3_000,
                label: 'Téléphone',
                categoryId: null,
                transferAccountId: null,
                counterparty: '',
                note: '',
                vatAmount: null,
                frequency: 'monthly',
                interval: 1,
                nextDate: addDays(DAY, -2),
                endDate: null,
                automatic: false,
                active: true
            }
        });
        await importLines(b, [line(3_000, 'PRLV FREE')]);
        const { lines } = await handlerFor(financeStatementList)(b.ctx, { status: 'pending' });
        assert.deepEqual(lines[0].proposals, [
            { kind: 'recurring', recurringId: recurring.id, label: 'Téléphone', date: addDays(DAY, -2) }
        ]);
        await handlerFor(financeStatementResolve)(b.ctx, {
            lineIds: [lines[0].id],
            action: { kind: 'post', recurringId: recurring.id }
        });
        assert.equal(b.repo.transactions[0].recurring_id, recurring.id);
        assert.equal(b.repo.transactions[0].cleared, 1);
        assert.equal(b.repo.lines[0].transaction_id, b.repo.transactions[0].id);
    });

    it('refuse de rattacher une opération qui confirme déjà une autre ligne', async () => {
        const b = await book();
        const { transaction } = await expense(b, 2_000, DAY);
        await importLines(b, [line(2_000, 'SNCF'), line(2_000, 'SNCF RETOUR')]);
        const other = b.repo.lines.find((l) => l.transaction_id === null);
        assert.ok(other);
        await assert.rejects(
            handlerFor(financeStatementResolve)(b.ctx, {
                lineIds: [other.id],
                action: { kind: 'link', transactionId: transaction.id }
            }),
            /déjà une autre ligne/
        );
    });

    it('écarte et rétablit, et une règle neuve range ce qui attendait', async () => {
        const b = await book();
        await importLines(b, [line(1_200, 'PRLV OVH'), line(900, 'CB CAFE')]);
        const cafe = b.repo.lines.find((l) => l.amount === 900);
        assert.ok(cafe);
        await handlerFor(financeStatementResolve)(b.ctx, { lineIds: [cafe.id], action: { kind: 'ignore' } });
        assert.equal(pending(b.repo).length, 1);
        await handlerFor(financeStatementResolve)(b.ctx, { lineIds: [cafe.id], action: { kind: 'restore' } });
        assert.equal(pending(b.repo).length, 2);

        await handlerFor(financeRuleSave)(b.ctx, {
            id: null,
            rule: { contains: 'OVH', direction: null, categoryId: b.hosting.id, vatRateBp: null }
        });
        assert.equal(pending(b.repo).length, 1);
    });
});

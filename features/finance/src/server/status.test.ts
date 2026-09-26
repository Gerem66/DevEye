import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestContext, createTestServiceDeps } from '@deveye/types/sdk/testing';

import {
    financeAccountAdd,
    financeCategoryAdd,
    financeConfig,
    financeStatusSet,
    financeTransactionAdd
} from '../contracts/commands';
import type { FinanceStatusSettings } from '../contracts/domain';
import { fakeRepo, handlerFor, type FakeRepo } from './_testing';
import { createService } from './service';
import { computeStatus } from './status';

/**
 * Ce qu'il faut mettre de côté, et les rappels de déclaration. Les dates sont
 * posées : le calendrier d'une déclaration se teste un jour choisi.
 */

const MICRO: FinanceStatusSettings = {
    legalStatus: 'micro',
    microActivity: 'bnc',
    provisionRateBp: null,
    incomeTaxPrepaid: false,
    declarationPeriod: 'quarterly',
    trackingSince: '2026-07-01'
};

async function book() {
    const repo = fakeRepo();
    const ctx = createTestContext({ repo });
    const { account } = await handlerFor(financeAccountAdd)(ctx, {
        account: { name: 'Pro', kind: 'checking', color: 'blue', initialBalance: 0, note: '', archived: false }
    });
    const category = async (
        name: string,
        flow: 'income' | 'expense',
        role: 'other' | 'social' | 'tax' | 'vat' | null
    ) =>
        (
            await handlerFor(financeCategoryAdd)(ctx, {
                category: { name, flow, color: 'blue', icon: 'other', role }
            })
        ).category.id;
    const entry = async (
        kind: 'income' | 'expense',
        amount: number,
        date: string,
        categoryId: number | null = null,
        vatAmount: number | null = null
    ) =>
        handlerFor(financeTransactionAdd)(ctx, {
            transaction: {
                accountId: account.id,
                kind,
                amount,
                date,
                label: '',
                categoryId,
                transferAccountId: null,
                counterparty: '',
                note: '',
                vatAmount,
                cleared: false
            }
        });
    return { repo, ctx, category, entry };
}

describe('micro-entreprise : la déclaration et ce qu’il faut garder', () => {
    it('garde les cotisations de la période close tant que son échéance n’est pas passée', async () => {
        const { ctx, category, entry } = await book();
        const refund = await category('Remboursements', 'income', 'other');
        await entry('income', 1_000_000, '2026-08-15');
        await entry('income', 50_000, '2026-09-01', refund);
        await entry('income', 200_000, '2026-10-05');

        const status = await computeStatus(ctx, MICRO, false, '2026-10-10', 5_000_000, null);
        assert.ok(status?.declaration);
        assert.equal(status.declaration.label, '3e trimestre 2026');
        assert.equal(status.declaration.closed, true);
        assert.equal(status.declaration.deadline, '2026-10-31');
        assert.equal(status.declaration.revenue, 1_000_000, 'le remboursement n’est pas du chiffre d’affaires');
        // 25,6 % de cotisations et 0,2 % de formation.
        assert.equal(status.declaration.contributions, 258_000);
        assert.equal(status.setAside.contributions, 258_000 + 51_600);
        assert.equal(status.available, 5_000_000 - status.setAside.total);
    });

    it('après l’échéance, ne garde plus que la période en cours', async () => {
        const { ctx, entry } = await book();
        await entry('income', 1_000_000, '2026-08-15');
        await entry('income', 200_000, '2026-10-05');

        const status = await computeStatus(ctx, MICRO, false, '2026-11-05', 0, null);
        assert.ok(status?.declaration);
        assert.equal(status.declaration.closed, false);
        assert.equal(status.declaration.label, '4e trimestre 2026');
        assert.equal(status.setAside.contributions, 51_600);
    });

    it('déclare le hors taxe, ajoute l’impôt libératoire s’il est choisi', async () => {
        const { ctx, entry } = await book();
        await entry('income', 120_000, '2026-08-15', null, 20_000);

        const status = await computeStatus(ctx, { ...MICRO, incomeTaxPrepaid: true }, true, '2026-10-10', 0, null);
        assert.ok(status?.declaration);
        assert.equal(status.declaration.revenue, 100_000);
        assert.equal(status.declaration.incomeTax, 2_200);
    });

    it('compte la TVA due depuis le jour de suivi, moins celle déjà reversée', async () => {
        const { ctx, category, entry } = await book();
        const vat = await category('TVA reversée', 'expense', 'vat');
        await entry('income', 120_000, '2026-08-15', null, 20_000);
        await entry('expense', 12_000, '2026-08-20', null, 2_000);
        await entry('expense', 10_000, '2026-09-10', vat);
        await entry('income', 60_000, '2026-06-10', null, 10_000);

        const status = await computeStatus(ctx, MICRO, true, '2026-10-10', 0, null);
        assert.equal(status?.setAside.vat, 20_000 - 2_000 - 10_000, 'juin précède le suivi');
    });

    it('situe l’année face aux seuils, factures en attente comprises', async () => {
        const { ctx, entry } = await book();
        await entry('income', 3_000_000, '2026-03-15');
        const receivable = {
            docId: 1,
            docNumber: 'F-1',
            clientName: '',
            currency: 'EUR',
            issuedOn: '2026-10-01',
            dueOn: '2026-10-31',
            remainingCents: 1_000_000,
            remainingVatCents: 0,
            overdue: false,
            segment: 'doc-1'
        };
        const status = await computeStatus(ctx, MICRO, false, '2026-10-10', 0, [receivable]);
        assert.deepEqual(status?.thresholds, {
            year: 2026,
            revenue: 3_000_000,
            projected: 4_000_000,
            ceiling: 8_360_000,
            vatBase: 3_750_000,
            vatMajor: 4_125_000
        });
    });
});

describe('entreprise : une part du bénéfice', () => {
    it('garde sa part du bénéfice, moins ce qui a déjà été versé', async () => {
        const { ctx, category, entry } = await book();
        const social = await category('Cotisations sociales', 'expense', 'social');
        await entry('income', 1_000_000, '2026-08-01');
        await entry('expense', 400_000, '2026-08-10');
        await entry('expense', 50_000, '2026-09-01', social);

        const company: FinanceStatusSettings = {
            legalStatus: 'company',
            microActivity: null,
            provisionRateBp: 2_500,
            incomeTaxPrepaid: false,
            declarationPeriod: null,
            trackingSince: '2026-07-01'
        };
        const status = await computeStatus(ctx, company, false, '2026-10-10', 0, null);
        assert.equal(status?.declaration, null);
        // (10 000 − 4 000) × 25 % − 500 déjà versés.
        assert.equal(status?.setAside.contributions, 100_000);
    });
});

describe('finance.statusSet', () => {
    it('demande l’activité et la cadence d’une micro-entreprise', async () => {
        const { ctx } = await book();
        await assert.rejects(
            handlerFor(financeStatusSet)(ctx, { status: { ...MICRO, microActivity: null } }),
            /activité/
        );
    });

    it('fait partir le suivi du mois en cours, et oublie ce qui ne sert plus', async () => {
        const { ctx, repo } = await book();
        await handlerFor(financeStatusSet)(ctx, { status: { ...MICRO, trackingSince: null } });
        assert.match(repo.config?.tracking_since ?? '', /^\d{4}-\d{2}-01$/);

        await handlerFor(financeStatusSet)(ctx, {
            status: { ...MICRO, legalStatus: 'company', incomeTaxPrepaid: true, provisionRateBp: 3_000 }
        });
        const { config } = await handlerFor(financeConfig)(ctx, {});
        assert.equal(config.status.microActivity, null);
        assert.equal(config.status.declarationPeriod, null);
        assert.equal(config.status.incomeTaxPrepaid, false);
        assert.equal(config.status.provisionRateBp, 3_000);
    });

    it('refuse un rôle qui ne va pas au sens de la catégorie', async () => {
        const { category } = await book();
        await assert.rejects(category('Ventes', 'income', 'social'), /chiffre d’affaires/);
        await assert.rejects(category('Frais', 'expense', 'other'), /charge/);
    });
});

describe('les rappels de déclaration', () => {
    async function declaring(): Promise<FakeRepo> {
        const { repo, ctx, entry } = await book();
        await handlerFor(financeStatusSet)(ctx, { status: MICRO });
        await entry('income', 1_000_000, '2026-08-15');
        return repo;
    }

    function tickAt(repo: FakeRepo, day: string) {
        const deps = createTestServiceDeps({ repo });
        createService(deps, () => day);
        const tick = deps.recorded.tickers[0]?.tick;
        assert.ok(tick, 'le service déclare bien une boucle');
        return { deps, tick };
    }

    it('prévient une semaine avant, une seule fois, puis la veille', async () => {
        const repo = await declaring();

        const week = tickAt(repo, '2026-10-26');
        await week.tick();
        await week.tick();
        assert.equal(week.deps.recorded.notifications.length, 1);
        const [first] = week.deps.recorded.notifications;
        assert.match(first.subject, /3e trimestre 2026/);
        assert.match(first.body, /10\s000,00/);
        assert.match(first.body, /31 octobre 2026/);

        const eve = tickAt(repo, '2026-10-30');
        await eve.tick();
        assert.equal(eve.deps.recorded.notifications.length, 1);
        assert.match(eve.deps.recorded.notifications[0].subject, /demain/);
    });

    it('ne dit rien loin de l’échéance', async () => {
        const repo = await declaring();
        const early = tickAt(repo, '2026-10-10');
        await early.tick();
        assert.equal(early.deps.recorded.notifications.length, 0);
    });
});

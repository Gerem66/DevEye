import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { invoicingDashboard, invoicingPaymentRemove, invoicingPaymentSave } from '../../contracts/commands';
import { addDays, periodBounds, startOfMonth } from '../../contracts/calendar';
import { formatMoney } from '../../contracts/display';
import { invoicingPaymentInputSchema, type InvoicingDoc, type InvoicingPayment } from '../../contracts/domain';
import { now, publicOriginOf, seal, settingsOf, today, WRITE, type Ctx, docOr404, assertClient } from '../_shared';
import { monthUsage } from '../planUsage';
import { EMPTY_CLIENT_USAGE, toClient } from './clients';
import { clientNamesOf, linesByDoc, regimeOf, toDoc, toLine, toPayments } from '../views';

/** Ce qu'une période met en face du mois précédent, et jusqu'où « bientôt » va. */
const SOON_DAYS = 8;
const ACTIONABLE_LIMIT = 12;

/** La fiche complète après une écriture : le document, et ses règlements. */
async function refreshed(ctx: Ctx, id: number): Promise<{ doc: InvoicingDoc; payments: InvoicingPayment[] }> {
    const row = await docOr404(ctx, id);
    const settings = await settingsOf(ctx);
    const [clientNames, settled, parentNumbers, lineRows, payments] = await Promise.all([
        clientNamesOf(ctx),
        ctx.repo.settledOf([id], ctx.workspaceId),
        ctx.repo.numbersOf(row.parent_doc_id === null ? [] : [row.parent_doc_id], ctx.workspaceId),
        ctx.repo.listLines([id], ctx.workspaceId),
        toPayments(ctx, id)
    ]);
    const vatRegime = regimeOf(row, settings.vatRegime);
    const lines = await Promise.all(lineRows.map((line) => toLine(ctx, line, vatRegime)));
    return {
        doc: await toDoc(ctx, row, lines, {
            today: today(settings),
            vatRegime: settings.vatRegime,
            publicOrigin: await publicOriginOf(ctx, settings),
            clientNames,
            settled,
            parentNumbers
        }),
        payments
    };
}

export const paymentSave = defineSdkFeature({
    ...invoicingPaymentSave,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.docId);
        await assertClient(ctx, row.client_id, 'write');
        if (row.kind !== 'invoice' || row.status !== 'issued') {
            throw new FeatureError(
                'conflict',
                'Un règlement se porte sur une facture émise : un brouillon n’attend encore rien.'
            );
        }
        if (input.payment.amountCents <= 0) {
            throw new FeatureError('validation', 'Un règlement porte un montant.');
        }

        const before = (await ctx.repo.settledOf([row.id], ctx.workspaceId)).get(row.id);
        const settledBefore = (before?.paidCents ?? 0) + (before?.creditedCents ?? 0) + (before?.deductedCents ?? 0);
        const gross = row.total_gross ?? 0;
        const remaining = Math.max(0, gross - settledBefore);
        if (input.payment.amountCents > remaining) {
            // Un trop-perçu n'est pas un reste dû à l'envers : c'est un avoir à
            // faire, et l'écran le dit plutôt que de laisser la somme dériver.
            throw new FeatureError(
                'conflict',
                `Il ne reste que ${formatMoney(remaining, row.currency)} à régler sur cette facture. Un trop-perçu se traite par un avoir.`
            );
        }

        await ctx.repo.insertPayment(
            ctx.workspaceId,
            {
                doc_id: row.id,
                paid_on: input.payment.paidOn,
                amount: input.payment.amountCents,
                method: input.payment.method,
                content: await seal(
                    ctx,
                    invoicingPaymentInputSchema.pick({ reference: true, note: true }).parse(input.payment)
                )
            },
            now()
        );

        const after = await refreshed(ctx, row.id);
        // La bascule ne se produit qu'une fois : la prévenance ne se répète pas.
        if (settledBefore < gross && after.doc.settledCents >= gross && gross > 0) {
            await ctx.deveye.notify.send(
                {
                    subject: `Facture ${row.number_label ?? ''} soldée`,
                    body: `${after.doc.clientName} a réglé ${formatMoney(gross, row.currency)}.`
                },
                { itemId: row.client_id ?? undefined }
            );
        }
        return after;
    }
});

export const paymentRemove = defineSdkFeature({
    ...invoicingPaymentRemove,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.docId);
        await assertClient(ctx, row.client_id, 'write');

        const removed = await ctx.repo.deletePayment(input.id, input.docId, ctx.workspaceId);
        if (removed === 0) throw new FeatureError('not_found', 'Ce règlement n’existe plus.');
        return refreshed(ctx, row.id);
    }
});

export const dashboard = defineSdkFeature({
    ...invoicingDashboard,
    handler: async (ctx: Ctx, input) => {
        const settings = await settingsOf(ctx);
        const day = today(settings);
        const { from, to } = periodBounds(day, input.range);
        // La période précédente, de même longueur : c'est ce qui donne son sens
        // à l'écart affiché sous la trésorerie.
        const before = periodBounds(addDays(from, -1), input.range);

        const [cashed, cashedBefore, billed, outstanding, quotes, months, actionableRows, usage] = await Promise.all([
            ctx.repo.cashedBetween(ctx.workspaceId, from, to),
            ctx.repo.cashedBetween(ctx.workspaceId, before.from, before.to),
            ctx.repo.billedBetween(ctx.workspaceId, from, to),
            ctx.repo.outstanding(ctx.workspaceId, day),
            ctx.repo.quotesPending(ctx.workspaceId, day),
            ctx.repo.monthlySeries(ctx.workspaceId, startOfMonth(addDays(day, -365)), day),
            ctx.repo.actionable(ctx.workspaceId, day, addDays(day, SOON_DAYS), ACTIONABLE_LIMIT),
            monthUsage(ctx.quota)
        ]);

        // Les derniers documents et les derniers clients, dans la même lecture :
        // la page d'accueil les montre juste sous les chiffres.
        const [recentPage, clientRows, restrictions] = await Promise.all([
            ctx.repo.listDocs(
                ctx.workspaceId,
                {
                    kind: null,
                    status: null,
                    derived: null,
                    clientId: null,
                    year: null,
                    search: '',
                    limit: input.recent,
                    offset: 0
                },
                day
            ),
            ctx.repo.listClients(ctx.workspaceId, false),
            ctx.items.restrictions()
        ]);

        const visible = <T extends { client_id: number | null }>(rows: readonly T[]) =>
            rows.filter((row) => row.client_id === null || restrictions.get(String(row.client_id)) !== 'none');

        const rows = visible(actionableRows);
        const recentRows = visible(recentPage.rows);
        const clients = clientRows.filter((row) => restrictions.get(String(row.id)) !== 'none').slice(0, input.recent);

        const [clientNames, settled, clientUsage] = await Promise.all([
            clientNamesOf(ctx),
            ctx.repo.settledOf(
                [...rows, ...recentRows].map((row) => row.id),
                ctx.workspaceId
            ),
            ctx.repo.clientUsage(ctx.workspaceId, day)
        ]);
        const parentNumbers = await ctx.repo.numbersOf(
            recentRows.map((row) => row.parent_doc_id).filter((id): id is number => id !== null),
            ctx.workspaceId
        );
        const view = {
            today: day,
            vatRegime: settings.vatRegime,
            publicOrigin: await publicOriginOf(ctx, settings),
            clientNames,
            settled,
            parentNumbers
        };

        // Un brouillon n'a pas encore de total figé : il se calcule sur ses lignes.
        const draftIds = [...rows, ...recentRows].filter((row) => row.total_gross === null).map((row) => row.id);
        const byDoc = await linesByDoc(ctx, draftIds, settings.vatRegime);

        const actionable: InvoicingDoc[] = [];
        for (const row of rows) actionable.push(await toDoc(ctx, row, byDoc.get(row.id) ?? [], view));

        const recentDocs: InvoicingDoc[] = [];
        for (const row of recentRows) recentDocs.push(await toDoc(ctx, row, byDoc.get(row.id) ?? [], view));

        const recentClients = await Promise.all(
            clients.map((row) => toClient(ctx, row, clientUsage.get(row.id) ?? EMPTY_CLIENT_USAGE))
        );

        return {
            dashboard: {
                currency: settings.currency,
                vatRegime: settings.vatRegime,
                from,
                to,
                cashedCents: cashed.cents,
                cashedBeforeCents: cashedBefore.cents,
                vatCollectedCents: cashed.vatCents,
                billedCents: Math.max(0, billed.grossCents),
                billedCount: billed.count,
                outstandingCents: outstanding.outstandingCents,
                overdueCents: outstanding.overdueCents,
                overdueCount: outstanding.overdueCount,
                quotesPendingCents: quotes.cents,
                quotesPendingCount: quotes.count,
                quotesExpiringSoon: quotes.expiring,
                months,
                usage
            },
            actionable,
            recentDocs,
            recentClients
        };
    }
});

export const paymentHandlers = [paymentSave, paymentRemove, dashboard];

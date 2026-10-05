import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    invoicingDocGet,
    invoicingDocList,
    invoicingDocRemove,
    invoicingDocSave,
    invoicingLinesSet
} from '../../contracts/commands';
import { documentTotals } from '../../contracts/money';
import { invoicingDocContentSchema, invoicingLineInputSchema, type InvoicingDoc } from '../../contracts/domain';
import { now, publicOriginOf, seal, settingsOf, today, WRITE, type Ctx, docOr404, assertClient } from '../_shared';
import { clientNamesOf, linesByDoc, regimeOf, toDoc, toPayments, type DocViewContext } from '../views';
import type { InvoicingDocRow, LineWrite } from '../repo';

const lineContentSchema = invoicingLineInputSchema.pick({ label: true, description: true });

/** Le contexte commun d'une projection : ce qu'il faut lire une fois pour toute une page. */
export async function viewContextOf(ctx: Ctx, rows: readonly InvoicingDocRow[]): Promise<DocViewContext> {
    const settings = await settingsOf(ctx);
    const parentIds = rows.map((row) => row.parent_doc_id).filter((id): id is number => id !== null);
    const [clientNames, settled, parentNumbers] = await Promise.all([
        clientNamesOf(ctx),
        ctx.repo.settledOf(
            rows.map((row) => row.id),
            ctx.workspaceId
        ),
        ctx.repo.numbersOf(parentIds, ctx.workspaceId)
    ]);
    return {
        today: today(settings),
        vatRegime: settings.vatRegime,
        publicOrigin: await publicOriginOf(ctx, settings),
        clientNames,
        settled,
        parentNumbers
    };
}

export const docList = defineSdkFeature({
    ...invoicingDocList,
    handler: async (ctx: Ctx, input) => {
        const settings = await settingsOf(ctx);
        const page = await ctx.repo.listDocs(ctx.workspaceId, { ...input }, today(settings));

        const restrictions = await ctx.items.restrictions();
        const rows = page.rows.filter(
            (row) => row.client_id === null || restrictions.get(String(row.client_id)) !== 'none'
        );

        const view = await viewContextOf(ctx, rows);
        // Seuls les brouillons ont besoin de leurs lignes : un document émis
        // porte ses totaux, et les relire ligne à ligne serait gratuit.
        const draftIds = rows.filter((row) => row.total_gross === null).map((row) => row.id);
        const byDoc = await linesByDoc(ctx, draftIds, settings.vatRegime);

        const docs: InvoicingDoc[] = [];
        for (const row of rows) docs.push(await toDoc(ctx, row, byDoc.get(row.id) ?? [], view));

        return {
            docs,
            totals: {
                count: page.count,
                outstandingCents: page.outstandingCents,
                overdueCents: page.overdueCents
            }
        };
    }
});

export const docGet = defineSdkFeature({
    ...invoicingDocGet,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'read');

        const settings = await settingsOf(ctx);
        const [view, byDoc, payments] = await Promise.all([
            viewContextOf(ctx, [row]),
            linesByDoc(ctx, [row.id], regimeOf(row, settings.vatRegime)),
            toPayments(ctx, row.id)
        ]);
        const lines = byDoc.get(row.id) ?? [];
        return { doc: await toDoc(ctx, row, lines, view), lines, payments };
    }
});

export const docSave = defineSdkFeature({
    ...invoicingDocSave,
    access: WRITE,
    mutates: ['invoicingDrafts'],
    handler: async (ctx: Ctx, input) => {
        const settings = await settingsOf(ctx);
        const at = now();
        const content = await seal(ctx, invoicingDocContentSchema.parse(input.doc));
        await assertClient(ctx, input.doc.clientId, 'write');

        let id = input.id;
        if (id === null) {
            id = await ctx.repo.insertDoc(
                ctx.workspaceId,
                {
                    client_id: input.doc.clientId,
                    kind: input.kind,
                    parent_doc_id: null,
                    is_deposit: 0,
                    // Figés à la création : un document ne change ni de devise
                    // ni de régime, même si l'espace en change après.
                    currency: settings.currency,
                    vat_regime: settings.vatRegime,
                    due_on: input.doc.dueOn,
                    valid_until: input.doc.validUntil,
                    deposit_bp: input.kind === 'quote' ? input.doc.depositBp : null,
                    performed_on: input.doc.performedOn,
                    content,
                    created_by: ctx.userId
                },
                at
            );
        } else {
            const current = await docOr404(ctx, id);
            await assertClient(ctx, current.client_id, 'write');
            const touched = await ctx.repo.updateDocDraft(
                id,
                ctx.workspaceId,
                {
                    client_id: input.doc.clientId,
                    due_on: input.doc.dueOn,
                    valid_until: input.doc.validUntil,
                    deposit_bp: current.kind === 'quote' ? input.doc.depositBp : null,
                    performed_on: input.doc.performedOn,
                    content
                },
                at
            );
            if (touched === 0) {
                throw new FeatureError(
                    'conflict',
                    'Ce document est émis : son en-tête ne change plus. Une erreur se corrige par un avoir.'
                );
            }
        }

        const row = await docOr404(ctx, id);
        const [view, byDoc] = await Promise.all([
            viewContextOf(ctx, [row]),
            linesByDoc(ctx, [row.id], regimeOf(row, settings.vatRegime))
        ]);
        return { doc: await toDoc(ctx, row, byDoc.get(row.id) ?? [], view) };
    }
});

export const linesSet = defineSdkFeature({
    ...invoicingLinesSet,
    access: WRITE,
    mutates: ['invoicingDrafts'],
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.docId);
        await assertClient(ctx, row.client_id, 'write');
        if (row.status !== 'draft') {
            throw new FeatureError(
                'conflict',
                'Ce document est émis : ses lignes ne changent plus. Une erreur se corrige par un avoir.'
            );
        }
        // Un brouillon suit le régime vivant, et non celui qui régnait à sa
        // création : en franchise, les taux tombent à zéro plutôt que d'être
        // refusés. Un refus aurait bloqué l'édition d'un brouillon né avant le
        // changement, sans qu'aucun geste de l'écran ne puisse le débloquer.
        const settings = await settingsOf(ctx);
        const exempt = settings.vatRegime === 'exempt';

        const writes: LineWrite[] = [];
        for (const [index, line] of input.lines.entries()) {
            writes.push({
                id: line.id,
                sort_order: index,
                kind: line.kind,
                quantity_milli: line.quantityMilli,
                unit: line.unit,
                unit_price: line.unitPrice,
                vat_bp: exempt ? 0 : line.vatRateBp,
                content: await seal(ctx, lineContentSchema.parse(line))
            });
        }
        await ctx.repo.setLines(input.docId, ctx.workspaceId, writes);

        const byDoc = await linesByDoc(ctx, [input.docId], settings.vatRegime);
        const lines = byDoc.get(input.docId) ?? [];
        const totals = documentTotals(
            lines.map((line) => ({
                kind: line.kind,
                quantityMilli: line.quantityMilli,
                unitPrice: line.unitPrice,
                vatRateBp: line.vatRateBp
            }))
        );
        return { lines, totals: { ...totals, vat: [...totals.vat] } };
    }
});

export const docRemove = defineSdkFeature({
    ...invoicingDocRemove,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'write');

        const removed = await ctx.repo.deleteDoc(input.id, ctx.workspaceId);
        if (removed === 0) {
            throw new FeatureError(
                'conflict',
                row.number === null
                    ? 'Ce document est émis : il ne se supprime pas. Une facture se corrige par un avoir.'
                    : 'Ce document porte déjà un numéro : terminez son émission plutôt que de le supprimer, sinon la suite des numéros aurait un trou.'
            );
        }
        return { ok: true as const };
    }
});

export const docHandlers = [docList, docGet, docSave, linesSet, docRemove];

import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { invoicingDocDerive } from '../../contracts/commands';
import { formatVatRate, kindLabel } from '../../contracts/display';
import { documentTotals } from '../../contracts/money';
import {
    invoicingDocContentSchema,
    invoicingLineInputSchema,
    type DocumentKind,
    type VatRegime
} from '../../contracts/domain';
import {
    assertClient,
    docOr404,
    now,
    openJson,
    publicOriginOf,
    seal,
    settingsOf,
    today,
    WRITE,
    type Ctx
} from '../_shared';
import { regimeOf, toDoc, toLine } from '../views';
import type { InvoicingDocRow, LineWrite } from '../repo';

/**
 * Les trois dérivations. Aucune ne fige quoi que ce soit : elles rendent un
 * **brouillon**, qui se corrige avant d'être émis. C'est ce qui permet de
 * traiter l'avoir partiel sans commande de plus : on dérive l'avoir total, puis
 * on retire ou on réduit ses lignes.
 */

const lineContentSchema = invoicingLineInputSchema.pick({ label: true, description: true });
const EMPTY_CONTENT = invoicingDocContentSchema.parse({});

async function linesOf(ctx: Ctx, doc: InvoicingDocRow, live: VatRegime) {
    const vatRegime = regimeOf(doc, live);
    return Promise.all(
        (await ctx.repo.listLines([doc.id], ctx.workspaceId)).map((line) => toLine(ctx, line, vatRegime))
    );
}

async function copyLines(ctx: Ctx, from: InvoicingDocRow, to: number, live: VatRegime): Promise<void> {
    const lines = await linesOf(ctx, from, live);
    const writes: LineWrite[] = [];
    for (const [index, line] of lines.entries()) {
        writes.push({
            id: null,
            sort_order: index,
            kind: line.kind,
            quantity_milli: line.quantityMilli,
            unit: line.unit,
            unit_price: line.unitPrice,
            vat_bp: line.vatRateBp,
            content: await seal(ctx, lineContentSchema.parse(line))
        });
    }
    await ctx.repo.setLines(to, ctx.workspaceId, writes);
}

/**
 * Un acompte porte **une ligne par taux** du devis, chacune à la part demandée
 * de sa base. Une seule ligne au taux dominant serait plus simple et fausserait
 * la ventilation de TVA dès qu'un devis mélange deux taux.
 */
async function depositLines(
    ctx: Ctx,
    quote: InvoicingDocRow,
    to: number,
    percentBp: number,
    live: VatRegime
): Promise<void> {
    const lines = await linesOf(ctx, quote, live);
    const totals = documentTotals(
        lines.map((line) => ({
            kind: line.kind,
            quantityMilli: line.quantityMilli,
            unitPrice: line.unitPrice,
            vatRateBp: line.vatRateBp
        }))
    );
    if (totals.netCents <= 0) {
        throw new FeatureError('validation', 'Ce devis est à zéro : il n’y a pas d’acompte à en tirer.');
    }

    const share = `${(percentBp / 100).toString().replace('.', ',')} %`;
    const reference = quote.number_label === null ? 'ce devis' : `le devis ${quote.number_label}`;
    const writes: LineWrite[] = [];
    for (const [index, vat] of totals.vat.entries()) {
        const amount = Math.floor((vat.netCents * percentBp + 5000) / 10_000);
        if (amount <= 0) continue;
        writes.push({
            id: null,
            sort_order: index,
            kind: 'service',
            quantity_milli: 1000,
            unit: 'fixed',
            unit_price: amount,
            vat_bp: vat.rateBp,
            content: await seal(ctx, {
                label: `Acompte de ${share} sur ${reference}`,
                description: totals.vat.length > 1 ? `Part soumise au taux de ${formatVatRate(vat.rateBp)}` : ''
            })
        });
    }
    await ctx.repo.setLines(to, ctx.workspaceId, writes);
}

export const docDerive = defineSdkFeature({
    ...invoicingDocDerive,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const source = await docOr404(ctx, input.id);
        await assertClient(ctx, source.client_id, 'write');

        const wantsQuote = input.mode !== 'credit';
        if (wantsQuote && source.kind !== 'quote') {
            throw new FeatureError('conflict', 'Une facture se tire d’un devis.');
        }
        if (!wantsQuote && source.kind !== 'invoice') {
            throw new FeatureError('conflict', 'Un avoir corrige une facture.');
        }
        if (source.status === 'draft') {
            throw new FeatureError(
                'conflict',
                `Ce ${kindLabel(source.kind as DocumentKind).toLowerCase()} est encore un brouillon : émettez-le d’abord.`
            );
        }

        const settings = await settingsOf(ctx);
        const day = today(settings);
        const at = now();
        const content = await openJson(ctx, source.content, invoicingDocContentSchema, EMPTY_CONTENT);

        if (input.mode === 'credit') {
            const settled = (await ctx.repo.settledOf([source.id], ctx.workspaceId)).get(source.id);
            const credited = settled?.creditedCents ?? 0;
            if (credited >= (source.total_gross ?? 0)) {
                throw new FeatureError('conflict', 'Cette facture est déjà annulée en entier par un avoir.');
            }
        } else {
            const born = await ctx.repo.listDocs(
                ctx.workspaceId,
                {
                    kind: 'invoice',
                    status: null,
                    derived: null,
                    clientId: null,
                    year: null,
                    search: '',
                    limit: 100,
                    offset: 0
                },
                day
            );
            const already = born.rows.filter((row) => row.parent_doc_id === source.id && row.is_deposit === 0);
            if (input.mode === 'invoice' && already.length > 0) {
                throw new FeatureError(
                    'conflict',
                    `Ce devis a déjà donné la facture ${already[0].number_label ?? 'en préparation'}.`
                );
            }
        }

        const id = await ctx.repo.insertDoc(
            ctx.workspaceId,
            {
                client_id: source.client_id,
                kind: input.mode === 'credit' ? 'credit' : 'invoice',
                parent_doc_id: source.id,
                is_deposit: input.mode === 'deposit' ? 1 : 0,
                // La devise et le régime sont ceux de la pièce d'origine : une
                // facture ne peut pas corriger un devis dans une autre monnaie.
                currency: source.currency,
                vat_regime: source.vat_regime,
                due_on: null,
                valid_until: null,
                performed_on: source.performed_on,
                content: await seal(ctx, {
                    ...content,
                    subject:
                        input.mode === 'deposit' && content.subject.length > 0
                            ? `Acompte sur ${content.subject}`
                            : content.subject
                }),
                created_by: ctx.userId
            },
            at
        );

        if (input.mode === 'deposit') await depositLines(ctx, source, id, input.percentBp, settings.vatRegime);
        else await copyLines(ctx, source, id, settings.vatRegime);

        if (input.mode === 'invoice') {
            // La facture de solde déduit les acomptes déjà émis sur ce devis :
            // sans cela, le client paierait deux fois la même part.
            for (const deposit of await ctx.repo.depositsOf(source.id, ctx.workspaceId)) {
                await ctx.repo.insertDeduction(
                    ctx.workspaceId,
                    { doc_id: id, deducted_doc_id: deposit.id, amount: deposit.total_gross ?? 0 },
                    at
                );
            }
        }

        const row = await docOr404(ctx, id);
        const [settled, parentNumbers, lines] = await Promise.all([
            ctx.repo.settledOf([id], ctx.workspaceId),
            ctx.repo.numbersOf([source.id], ctx.workspaceId),
            linesOf(ctx, row, settings.vatRegime)
        ]);
        return {
            doc: await toDoc(ctx, row, lines, {
                today: day,
                vatRegime: settings.vatRegime,
                publicOrigin: await publicOriginOf(ctx, settings),
                clientNames: new Map(),
                settled,
                parentNumbers
            })
        };
    }
});

export const deriveHandlers = [docDerive];

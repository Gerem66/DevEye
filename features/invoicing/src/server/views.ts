import { documentTotals, type MoneyLine } from '../contracts/money';
import { effectiveStatus } from '../contracts/status';
import {
    invoicingClientContentSchema,
    invoicingDocContentSchema,
    invoicingLineInputSchema,
    invoicingPaymentInputSchema,
    type DocumentKind,
    type DocumentStatus,
    type InvoicingDoc,
    type InvoicingLine,
    type InvoicingPayment,
    type InvoicingTotals,
    type LineKind,
    type LineUnit,
    type PaymentMethod,
    type VatRegime
} from '../contracts/domain';
import { openJson, type CipherIo, type Ctx } from './_shared';
import type { InvoicingDocRow, InvoicingLineRow, InvoicingSettled } from './repo';

/**
 * De la ligne SQL à ce que l'écran reçoit. Deux régimes, et c'est tout le sujet
 * de ce fichier : un brouillon recalcule ses totaux depuis ses lignes et lit le
 * client vivant ; un document émis rend ce qui a été figé, instantané des deux
 * parties compris.
 */

const EMPTY_CONTENT = invoicingDocContentSchema.parse({});
const NO_SETTLED: InvoicingSettled = { paidCents: 0, creditedCents: 0, deductedCents: 0 };

/** Le contenu scellé d'une ligne. */
const lineContentSchema = invoicingLineInputSchema.pick({ label: true, description: true });
const EMPTY_LINE_CONTENT = lineContentSchema.parse({ label: '' });

/**
 * Le régime de TVA qui s'applique à un document : celui des réglages tant que
 * c'est un brouillon, celui que l'émission a figé ensuite. Un brouillon suit le
 * vivant, comme il suit le nom vivant de son client : rien n'y est encore engagé,
 * et passer à la TVA en cours de route doit rattraper ce qui n'est pas parti.
 */
export function regimeOf(row: InvoicingDocRow, live: VatRegime): VatRegime {
    return row.status === 'draft' ? live : (row.vat_regime as VatRegime);
}

export async function toLine(
    io: CipherIo,
    row: InvoicingLineRow,
    /** Le régime du document ({@link regimeOf}) : en franchise, aucun taux ne tient. */
    vatRegime: VatRegime
): Promise<InvoicingLine> {
    const content = await openJson(io, row.content, lineContentSchema, EMPTY_LINE_CONTENT);
    // En franchise, le taux resté sur une ligne d'un brouillon ne vaut plus rien :
    // il s'efface ici pour que l'écran, les totaux et l'émission voient la même
    // chose. L'émission le fige ensuite à zéro.
    const vatRateBp = vatRegime === 'exempt' ? 0 : row.vat_bp;
    const line: MoneyLine = {
        kind: row.kind as LineKind,
        quantityMilli: row.quantity_milli,
        unitPrice: row.unit_price,
        vatRateBp
    };
    return {
        id: row.id,
        kind: line.kind,
        label: content.label,
        description: content.description,
        quantityMilli: row.quantity_milli,
        unit: row.unit as LineUnit,
        unitPrice: row.unit_price,
        vatRateBp,
        // Figé à l'émission, recalculé tant que c'est un brouillon : les deux
        // passent par la même fonction, donc ils ne peuvent pas diverger.
        netCents: row.net_amount ?? documentTotals([line]).netCents
    };
}

function totalsOf(row: InvoicingDocRow, lines: readonly InvoicingLine[]): InvoicingTotals {
    const computed = documentTotals(
        lines.map((line) => ({
            kind: line.kind,
            quantityMilli: line.quantityMilli,
            unitPrice: line.unitPrice,
            vatRateBp: line.vatRateBp
        }))
    );
    if (row.total_gross === null) return { ...computed, vat: [...computed.vat] };
    // Un document émis rend ce qu'il montrait : seule la ventilation par taux
    // se recalcule, depuis des lignes elles-mêmes figées.
    return {
        netCents: row.total_net ?? computed.netCents,
        vatCents: row.total_vat ?? computed.vatCents,
        grossCents: row.total_gross,
        vat: [...computed.vat]
    };
}

export interface DocViewContext {
    today: string;
    /** Le régime de TVA de l'espace, celui que suivent les brouillons. */
    vatRegime: VatRegime;
    /** L'origine publique de cet hôte, pour écrire le lien du client. */
    publicOrigin: string;
    /** Le nom vivant des clients, pour les brouillons. */
    clientNames: ReadonlyMap<number, string>;
    settled: ReadonlyMap<number, InvoicingSettled>;
    parentNumbers: ReadonlyMap<number, string>;
}

export async function toDoc(
    ctx: Ctx,
    row: InvoicingDocRow,
    lines: readonly InvoicingLine[],
    view: DocViewContext
): Promise<InvoicingDoc> {
    const stored = await openJson(ctx, row.content, invoicingDocContentSchema, EMPTY_CONTENT);
    // La réponse du client reste hors du contenu modifiable : elle appartient au
    // document, et l'écran n'en rend que le nom et l'heure.
    const { acceptance, ...content } = stored;
    const totals = totalsOf(row, lines);

    const settled = view.settled.get(row.id) ?? NO_SETTLED;
    const settledCents = settled.paidCents + settled.creditedCents + settled.deductedCents;

    // Un document émis porte le nom d'alors ; un brouillon suit le client
    // vivant, puisque rien n'est encore figé.
    let clientName = row.client_id === null ? '' : (view.clientNames.get(row.client_id) ?? '');
    if (row.client_snapshot !== null) {
        const snapshot = await openJson(ctx, row.client_snapshot, invoicingClientContentSchema, null);
        if (snapshot !== null) clientName = snapshot.name;
    }

    const status = row.status as DocumentStatus;
    const kind = row.kind as DocumentKind;

    return {
        ...content,
        id: row.id,
        kind,
        status,
        displayStatus: effectiveStatus(
            {
                kind,
                status,
                dueOn: row.due_on,
                validUntil: row.valid_until,
                grossCents: row.total_gross,
                settledCents,
                sentAt: row.sent_at
            },
            view.today
        ),
        numberLabel: row.number_label,
        publicUrl: row.public_token === null ? null : `${view.publicOrigin}/f/${encodeURIComponent(row.public_token)}`,
        answer: acceptance === null ? null : { name: acceptance.name, at: acceptance.at },
        sentAt: row.sent_at,
        clientId: row.client_id,
        clientName,
        issuedOn: row.issued_on,
        dueOn: row.due_on,
        validUntil: row.valid_until,
        performedOn: row.performed_on,
        currency: row.currency,
        vatRegime: regimeOf(row, view.vatRegime),
        totals,
        settledCents,
        remainingCents: Math.max(0, totals.grossCents - settledCents),
        parentId: row.parent_doc_id,
        parentNumber: row.parent_doc_id === null ? null : (view.parentNumbers.get(row.parent_doc_id) ?? null),
        updated: row.updated
    };
}

const paymentContentSchema = invoicingPaymentInputSchema.pick({ reference: true, note: true });
const EMPTY_PAYMENT_CONTENT = paymentContentSchema.parse({});

/** Les règlements d'un document, descellés. */
export async function toPayments(ctx: Ctx, docId: number): Promise<InvoicingPayment[]> {
    const rows = await ctx.repo.listPayments(docId, ctx.workspaceId);
    return Promise.all(
        rows.map(async (row) => {
            const content = await openJson(ctx, row.content, paymentContentSchema, EMPTY_PAYMENT_CONTENT);
            return {
                ...content,
                id: row.id,
                paidOn: row.paid_on,
                amountCents: row.amount,
                method: row.method as PaymentMethod
            };
        })
    );
}

/** Le nom vivant de chaque client de l'espace, pour les brouillons. */
export async function clientNamesOf(ctx: Ctx): Promise<Map<number, string>> {
    const rows = await ctx.repo.listClients(ctx.workspaceId, true);
    const names = new Map<number, string>();
    for (const row of rows) {
        const plain = await ctx.cipher().tryDecrypt(row.content);
        if (plain === null) continue;
        const parsed = invoicingClientContentSchema.safeParse(JSON.parse(plain));
        if (parsed.success) names.set(row.id, parsed.data.name);
    }
    return names;
}

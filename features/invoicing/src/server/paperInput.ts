import { dayIn } from '../contracts/calendar';
import { formatDate } from '../contracts/display';
import { depositTotals, documentTotals, quoteDepositBp } from '../contracts/money';
import {
    invoicingClientContentSchema,
    invoicingDocContentSchema,
    invoicingIssuerSchema,
    type DocumentKind,
    type InvoicingClientContent,
    type InvoicingIssuer
} from '../contracts/domain';
import type { PaperInput } from './paper';
import { openJson, settingsOf, type RepoIo } from './_shared';
import { regimeOf, toLine } from './views';
import type { InvoicingDocRow } from './repo';

/**
 * Ce qu'il faut réunir pour dessiner un document, sans session : la page
 * publique et la commande d'aperçu passent toutes deux par ici, donc elles
 * rendent la même chose.
 *
 * Un brouillon prend l'émetteur et le client **vivants**, puisque rien n'est
 * encore figé ; un document émis, les instantanés qu'il porte.
 */

const EMPTY_CONTENT = invoicingDocContentSchema.parse({});
/**
 * Un client vide. Écrit à la main et non tiré du schéma : celui-ci exige un
 * nom, à raison, et un document sans client est un cas de repli, pas une saisie.
 */
const EMPTY_CLIENT: InvoicingClientContent = {
    name: '',
    contactName: '',
    email: '',
    phone: '',
    address: '',
    postalCode: '',
    city: '',
    country: '',
    siret: '',
    vatNumber: '',
    note: ''
};

export async function paperInputOf(io: RepoIo, row: InvoicingDocRow): Promise<PaperInput> {
    const settings = await settingsOf(io);
    const content = await openJson(io, row.content, invoicingDocContentSchema, EMPTY_CONTENT);

    let issuer: InvoicingIssuer = settings.issuer;
    if (row.issuer_snapshot !== null) {
        issuer = await openJson(io, row.issuer_snapshot, invoicingIssuerSchema, settings.issuer);
    }

    let client: InvoicingClientContent = EMPTY_CLIENT;
    if (row.client_snapshot !== null) {
        client = await openJson(io, row.client_snapshot, invoicingClientContentSchema, EMPTY_CLIENT);
    } else if (row.client_id !== null) {
        const clientRow = await io.repo.findClient(row.client_id, io.workspaceId);
        if (clientRow !== null) {
            client = await openJson(io, clientRow.content, invoicingClientContentSchema, EMPTY_CLIENT);
        }
    }

    // Un brouillon s'imprime dans le régime vivant : son aperçu doit montrer ce
    // que l'émission figera, pas ce que ses colonnes gardent encore.
    const vatRegime = regimeOf(row, settings.vatRegime);
    const lines = await Promise.all(
        (await io.repo.listLines([row.id], io.workspaceId)).map((line) => toLine(io, line, vatRegime))
    );
    const computed = documentTotals(
        lines.map((line) => ({
            kind: line.kind,
            quantityMilli: line.quantityMilli,
            unitPrice: line.unitPrice,
            vatRateBp: line.vatRateBp
        }))
    );
    const totals =
        row.total_gross === null
            ? { ...computed, vat: [...computed.vat] }
            : {
                  netCents: row.total_net ?? computed.netCents,
                  vatCents: row.total_vat ?? computed.vatCents,
                  grossCents: row.total_gross,
                  vat: [...computed.vat]
              };

    const settled = (await io.repo.settledOf([row.id], io.workspaceId)).get(row.id) ?? {
        paidCents: 0,
        creditedCents: 0,
        deductedCents: 0
    };
    const settledCents = settled.paidCents + settled.creditedCents + settled.deductedCents;

    const deductionRows = await io.repo.listDeductions(row.id, io.workspaceId);
    const numbers = await io.repo.numbersOf(
        [
            ...deductionRows.map((entry) => entry.deducted_doc_id),
            ...(row.parent_doc_id === null ? [] : [row.parent_doc_id])
        ],
        io.workspaceId
    );

    const { acceptance, ...editable } = content;
    const depositBp = quoteDepositBp(
        { kind: row.kind, status: row.status, depositBp: row.deposit_bp },
        settings.defaultDepositBp
    );

    return {
        ...editable,
        kind: row.kind as DocumentKind,
        numberLabel: row.number_label,
        issuedOn: row.issued_on,
        dueOn: row.due_on,
        validUntil: row.valid_until,
        performedOn: row.performed_on,
        currency: row.currency,
        vatRegime,
        issuer,
        client,
        wording: settings.wording,
        lines,
        totals,
        settledCents,
        remainingCents: Math.max(0, totals.grossCents - settledCents),
        deposit:
            depositBp === 0
                ? null
                : { percentBp: depositBp, grossCents: depositTotals(computed, depositBp).grossCents },
        deductions: deductionRows.map((entry) => ({
            label: `Acompte déjà facturé${numbers.has(entry.deducted_doc_id) ? ` (${numbers.get(entry.deducted_doc_id)})` : ''}`,
            amountCents: entry.amount
        })),
        parentNumber: row.parent_doc_id === null ? null : (numbers.get(row.parent_doc_id) ?? null),
        awaitingAnswer: row.kind === 'quote' && row.status === 'sent',
        acceptedNote:
            row.accepted_at === null
                ? null
                : `Devis accepté en ligne le ${formatDate(dayIn(settings.timeZone, new Date(row.accepted_at * 1000)))}${
                      acceptance === null || acceptance.name.trim().length === 0 ? '' : ` par ${acceptance.name}`
                  }.`
    };
}

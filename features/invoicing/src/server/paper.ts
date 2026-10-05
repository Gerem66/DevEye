import { formatDate, formatMoney, formatVatRate, kindLabel, quantityToInput, unitLabel } from '../contracts/display';
import type {
    DocumentKind,
    InvoicingClientContent,
    InvoicingIssuer,
    InvoicingLine,
    InvoicingTotals,
    InvoicingWording,
    VatRegime
} from '../contracts/domain';
import { legalFormLine } from '../contracts/issuer';

/**
 * Le document imprimable, en une chaîne HTML autonome. Elle sert trois fois :
 * l'aperçu et l'impression dans l'application, la page publique que le client
 * ouvre, et le corps du courriel. Une seule mise en page, donc aucune divergence
 * possible entre ce que l'utilisateur voit, ce que son client reçoit et ce qui
 * s'imprime.
 *
 * Elle est construite côté serveur, contrairement à l'export des Notes : la
 * raison qui obligeait celui-là à rester dans le navigateur (le contenu ne
 * devait pas sortir de la page) ne s'applique pas ici, puisque le serveur
 * détient la clé de l'étage ouvert, et que la page publique en a besoin de
 * toute façon.
 */

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Les lignes non vides d'un bloc d'adresse, dans l'ordre où elles se lisent. */
function addressLines(party: { address: string; postalCode: string; city: string; country: string }): string[] {
    const place = [party.postalCode, party.city].filter((part) => part.trim().length > 0).join(' ');
    return [party.address, place, party.country].filter((part) => part.trim().length > 0);
}

function block(lines: readonly (string | null)[]): string {
    return lines
        .filter((line): line is string => line !== null && line.trim().length > 0)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('\n');
}

export interface PaperInput {
    kind: DocumentKind;
    numberLabel: string | null;
    issuedOn: string | null;
    dueOn: string | null;
    validUntil: string | null;
    performedOn: string | null;
    subject: string;
    intro: string;
    notes: string;
    terms: string;
    purchaseOrder: string;
    currency: string;
    vatRegime: VatRegime;
    issuer: InvoicingIssuer;
    client: InvoicingClientContent;
    wording: InvoicingWording;
    lines: readonly InvoicingLine[];
    totals: InvoicingTotals;
    settledCents: number;
    remainingCents: number;
    /** Les acomptes déjà facturés que ce document déduit. */
    deductions: readonly { label: string; amountCents: number }[];
    /** Le numéro de la facture qu'un avoir corrige. */
    parentNumber: string | null;
    /** La trace d'une acceptation en ligne, quand il y en a une. */
    acceptedNote: string | null;
    /**
     * Un devis qui attend encore la réponse de son client, et lui seul : c'est ce
     * qui décide du cadre de signature. Répondu, le cadre n'a plus d'objet, et
     * derrière une réponse en ligne il contredirait la ligne qui la dit.
     */
    awaitingAnswer: boolean;
    /**
     * Un bloc de plus, posé avant le pied de page. **Du HTML brut** : il n'est
     * jamais construit à partir de données saisies, seulement par la page
     * publique, qui y met son formulaire d'acceptation.
     */
    extra?: string;
}

/**
 * L'encre du document. Des valeurs littérales, et c'est voulu : une facture
 * imprimée n'appartient pas à l'interface, elle n'a pas de thème, et elle ne
 * doit pas changer de couleur selon l'accent que son lecteur s'est choisi. Elles
 * sont déclarées une fois, ici.
 */
const INK = `
    --ink: #14181d;
    --muted: #5b6672;
    --faint: #8a939d;
    --rule: #c9d0d8;
    --band: #f1f4f7;
`;

const STYLE = `
    @page { margin: 18mm 16mm 20mm; }
    * { box-sizing: border-box; }
    body {
        ${INK}
        margin: 0;
        color: var(--ink);
        background: #fff;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        font-size: 10.5pt;
        line-height: 1.45;
    }
    .sheet { max-width: 180mm; margin: 0 auto; padding: 10mm 0; }
    p { margin: 0; }
    h1 { margin: 0; font-size: 20pt; letter-spacing: 0.08em; text-transform: uppercase; }
    h2 { margin: 0 0 2mm; font-size: 9pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .head { display: flex; justify-content: space-between; gap: 10mm; align-items: flex-start; }
    .issuer { max-width: 95mm; }
    .issuer .name { font-size: 13pt; font-weight: 600; }
    .issuer p, .party p { color: var(--muted); }
    .issuer .name, .party .name { color: var(--ink); }
    .logo { max-width: 26mm; max-height: 26mm; margin-bottom: 3mm; }
    .doc { text-align: right; }
    .doc .num { margin-top: 1mm; font-size: 12pt; font-weight: 600; }
    .doc dl { margin: 4mm 0 0; }
    .doc .row { display: flex; justify-content: flex-end; gap: 4mm; }
    .doc dt { color: var(--muted); }
    .doc dd { margin: 0; }
    .party { margin: 10mm 0 0; padding: 4mm; border: 1pt solid var(--rule); width: 85mm; margin-left: auto; }
    .context { margin: 8mm 0 4mm; color: var(--muted); }
    .intro { margin: 0 0 4mm; }
    table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    th, td { padding: 2mm 2mm; text-align: left; vertical-align: top; }
    thead th { background: var(--band); color: var(--muted); font-size: 8.5pt; text-transform: uppercase;
               letter-spacing: 0.04em; font-weight: 600; }
    tbody th { font-weight: 500; }
    tbody td, tbody th { border-bottom: 0.5pt solid var(--rule); }
    td.num, th.num { text-align: right; white-space: nowrap; }
    .detail { display: block; color: var(--muted); font-size: 9pt; font-weight: 400; }
    .comment td { color: var(--muted); font-style: italic; }
    .totals { margin-top: 6mm; margin-left: auto; width: 90mm; break-inside: avoid; }
    .totals .row { display: flex; justify-content: space-between; gap: 6mm; padding: 1.2mm 0; }
    .totals .row.grand { margin-top: 1.5mm; padding-top: 2mm; border-top: 1pt solid var(--ink); font-weight: 600;
                         font-size: 12pt; }
    .totals .label { color: var(--muted); }
    .totals .grand .label { color: var(--ink); }
    .pay { margin-top: 8mm; break-inside: avoid; }
    .pay p { color: var(--muted); }
    .sign { margin-top: 10mm; padding: 4mm; border: 1pt solid var(--rule); width: 90mm; break-inside: avoid; }
    .sign .line { margin-top: 12mm; border-bottom: 0.5pt solid var(--rule); }
    .mentions { margin-top: 10mm; padding-top: 3mm; border-top: 0.5pt solid var(--rule);
                color: var(--faint); font-size: 8.5pt; }
    .accepted { margin-top: 6mm; padding: 3mm; background: var(--band); font-size: 9.5pt; }
    /* À l'écran, la feuille n'a plus les marges de la page imprimée : sans cette
       gouttière, le texte touche les bords d'un téléphone. */
    @media screen { .sheet { padding: 10mm 5mm; } }
    @media screen and (max-width: 640px) {
        body { font-size: 10pt; }
        .sheet { padding: 6mm 4mm; }
        .head { flex-direction: column; gap: 6mm; }
        .issuer { max-width: none; }
        .doc { text-align: left; }
        .doc .row { justify-content: flex-start; }
        .party, .sign { width: auto; margin-left: 0; }
        .totals { width: 100%; }
        th, td { padding: 1.5mm 1mm; }
        thead th.num { white-space: normal; }
    }
`;

/** Le titre en tête du document : c'est une mention obligatoire à lui tout seul. */
function headline(kind: DocumentKind): string {
    return kindLabel(kind).toUpperCase();
}

function rowsOf(input: PaperInput): string {
    const withVat = input.vatRegime === 'standard';
    const columns = withVat ? 5 : 4;

    return input.lines
        .map((line) => {
            if (line.kind === 'text') {
                return `<tr class="comment"><td colspan="${columns}">${escapeHtml(line.label)}</td></tr>`;
            }
            const detail =
                line.description.trim().length > 0 ? `<span class="detail">${escapeHtml(line.description)}</span>` : '';
            return `<tr>
                <th scope="row">${escapeHtml(line.label)}${detail}</th>
                <td class="num">${escapeHtml(quantityToInput(line.quantityMilli))} ${escapeHtml(unitLabel(line.unit, line.quantityMilli))}</td>
                <td class="num">${escapeHtml(formatMoney(line.unitPrice, input.currency))}</td>
                ${withVat ? `<td class="num">${escapeHtml(formatVatRate(line.vatRateBp))}</td>` : ''}
                <td class="num">${escapeHtml(formatMoney(line.netCents, input.currency))}</td>
            </tr>`;
        })
        .join('\n');
}

function totalsOf(input: PaperInput): string {
    const money = (cents: number) => escapeHtml(formatMoney(cents, input.currency));
    const rows: string[] = [
        `<div class="row"><span class="label">Total hors taxes</span><span>${money(input.totals.netCents)}</span></div>`
    ];

    if (input.vatRegime === 'standard') {
        // Le récapitulatif par taux est une mention obligatoire : une ligne par
        // taux, sa base et sa taxe.
        for (const share of input.totals.vat) {
            rows.push(
                `<div class="row"><span class="label">TVA ${escapeHtml(formatVatRate(share.rateBp))} sur ${money(share.netCents)}</span><span>${money(share.vatCents)}</span></div>`
            );
        }
    }

    rows.push(
        `<div class="row grand"><span class="label">Total ${input.vatRegime === 'standard' ? 'toutes taxes comprises' : 'à payer'}</span><span>${money(input.totals.grossCents)}</span></div>`
    );

    for (const deduction of input.deductions) {
        rows.push(
            `<div class="row"><span class="label">${escapeHtml(deduction.label)}</span><span>&minus;&nbsp;${money(deduction.amountCents)}</span></div>`
        );
    }
    if (input.settledCents > 0) {
        rows.push(
            `<div class="row"><span class="label">Déjà réglé</span><span>${money(input.settledCents)}</span></div>`,
            `<div class="row grand"><span class="label">Reste à payer</span><span>${money(input.remainingCents)}</span></div>`
        );
    }

    return `<section class="totals">${rows.join('\n')}</section>`;
}

export function renderPaper(input: PaperInput): string {
    const withVat = input.vatRegime === 'standard';
    const issuer = input.issuer;
    const client = input.client;
    const title = `${kindLabel(input.kind)}${input.numberLabel === null ? '' : ` ${input.numberLabel}`}`;

    const dateRows: string[] = [];
    const addRow = (label: string, value: string | null) => {
        if (value !== null) {
            dateRows.push(`<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`);
        }
    };
    addRow("Date d'émission", input.issuedOn === null ? null : formatDate(input.issuedOn));
    addRow('Prestation réalisée le', input.performedOn === null ? null : formatDate(input.performedOn));
    addRow('À payer avant le', input.dueOn === null ? null : formatDate(input.dueOn));
    addRow("Valable jusqu'au", input.validUntil === null ? null : formatDate(input.validUntil));
    addRow('Annule la facture', input.parentNumber);

    const context = [
        input.subject.trim().length > 0 ? `Objet : ${input.subject}` : null,
        input.purchaseOrder.trim().length > 0 ? `Bon de commande n° ${input.purchaseOrder}` : null
    ]
        .filter((part): part is string => part !== null)
        .join(' · ');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<article class="sheet">
    <header class="head">
        <div class="issuer">
            ${issuer.logo.trim().length > 0 ? `<img class="logo" src="${escapeHtml(issuer.logo)}" alt="">` : ''}
            <p class="name">${escapeHtml(issuer.legalName)}</p>
            ${block([
                issuer.tradeName === issuer.legalName ? null : issuer.tradeName,
                legalFormLine(issuer),
                ...addressLines(issuer),
                issuer.siret.trim().length > 0 ? `SIRET ${issuer.siret}` : null,
                issuer.rcs.trim().length > 0 ? `RCS ${issuer.rcs}` : null,
                withVat && issuer.vatNumber.trim().length > 0 ? `TVA ${issuer.vatNumber}` : null,
                [issuer.phone, issuer.email, issuer.website].filter((part) => part.trim().length > 0).join(' · ')
            ])}
        </div>
        <div class="doc">
            <h1>${escapeHtml(headline(input.kind))}</h1>
            ${input.numberLabel === null ? '<p class="num">Brouillon</p>' : `<p class="num">${escapeHtml(input.numberLabel)}</p>`}
            <dl>${dateRows.join('\n')}</dl>
        </div>
    </header>

    <section class="party">
        <h2>${escapeHtml(input.kind === 'quote' ? 'Destinataire' : 'Facturé à')}</h2>
        <p class="name">${escapeHtml(client.name)}</p>
        ${block([
            client.contactName,
            ...addressLines(client),
            client.siret.trim().length > 0 ? `SIRET ${client.siret}` : null,
            client.vatNumber.trim().length > 0 ? `TVA ${client.vatNumber}` : null
        ])}
    </section>

    ${context.length > 0 ? `<p class="context">${escapeHtml(context)}</p>` : ''}
    ${input.intro.trim().length > 0 ? `<p class="intro">${escapeHtml(input.intro)}</p>` : ''}

    <table>
        <thead>
            <tr>
                <th scope="col">Désignation</th>
                <th scope="col" class="num">Quantité</th>
                <th scope="col" class="num">Prix unitaire HT</th>
                ${withVat ? '<th scope="col" class="num">TVA</th>' : ''}
                <th scope="col" class="num">Total HT</th>
            </tr>
        </thead>
        <tbody>${rowsOf(input)}</tbody>
    </table>

    ${totalsOf(input)}

    ${input.acceptedNote === null ? '' : `<p class="accepted">${escapeHtml(input.acceptedNote)}</p>`}

    <section class="pay">
        ${block([
            input.terms.trim().length > 0 ? input.terms : input.wording.paymentTerms,
            input.notes,
            issuer.iban.trim().length > 0
                ? `IBAN ${issuer.iban}${issuer.bic.trim().length > 0 ? ` · BIC ${issuer.bic}` : ''}`
                : null,
            input.kind === 'quote' ? input.wording.quoteTerms : input.wording.lateFeeText,
            input.kind === 'quote' ? null : input.wording.recoveryFeeText,
            input.kind === 'quote' ? null : input.wording.discountText
        ])}
    </section>

    ${
        input.awaitingAnswer
            ? `<section class="sign">
                   <p>${escapeHtml(input.wording.signatureText)}</p>
                   <div class="line"></div>
               </section>`
            : ''
    }

    ${input.extra ?? ''}

    <footer class="mentions">
        ${block([
            withVat ? null : input.wording.exemptionText,
            issuer.insurer.trim().length > 0
                ? `Assurance professionnelle : ${issuer.insurer}${issuer.insuranceScope.trim().length > 0 ? ` (${issuer.insuranceScope})` : ''}`
                : null,
            input.wording.footer
        ])}
    </footer>
</article>
</body>
</html>`;
}

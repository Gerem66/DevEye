import type { SdkMailSample, SdkWorkspaceMail } from '@deveye/types/sdk/server';

import { DEFAULT_SETTINGS } from '../contracts/defaults';
import { formatDate, formatMoney, kindLabel } from '../contracts/display';
import type { InvoicingLine } from '../contracts/domain';
import { documentTotals } from '../contracts/money';
import { escapeHtml, renderPaper, type PaperInput } from './paper';

/**
 * Le mail d'un document au client : le document en HTML dans le corps, et le
 * lien vers sa page quand elle existe déjà. `text` reste complet : un
 * destinataire dont le client n'affiche pas le HTML ne doit rien perdre.
 */
export function documentMail(input: {
    paper: PaperInput;
    /** La page publique du document, ou `null` : l'envoi n'en crée pas. */
    url: string | null;
    /** Le mot de l'expéditeur, à la place de la phrase d'usage. */
    message: string;
}): SdkWorkspaceMail {
    const { paper, url } = input;
    const title = `${kindLabel(paper.kind)} ${paper.numberLabel ?? ''}`.trim();
    const amount = formatMoney(paper.totals.grossCents, paper.currency);
    const deadline =
        paper.kind === 'quote'
            ? paper.validUntil === null
                ? ''
                : ` Il est valable jusqu’au ${formatDate(paper.validUntil)}.`
            : paper.dueOn === null
              ? ''
              : ` Son règlement est attendu avant le ${formatDate(paper.dueOn)}.`;
    const intro = input.message.trim();
    const lead = `${intro.length > 0 ? intro : `Vous trouverez ci-dessous ${kindLabel(paper.kind).toLowerCase()} ${paper.numberLabel ?? ''} d’un montant de ${amount}.`.replace(/\s+/g, ' ')}${deadline}`;
    const lines = [
        'Bonjour,',
        '',
        lead,
        ...(url === null ? [] : ['', `Le document en ligne : ${url}`]),
        '',
        paper.issuer.legalName
    ];
    const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:40rem;margin:0 auto">
<p>${escapeHtml(lead)}</p>
${url === null ? '' : `<p><a href="${escapeHtml(url)}">Ouvrir le document en ligne</a></p>`}
</div>
${renderPaper(paper)}`;
    return { subject: `${title} · ${paper.issuer.legalName}`, text: lines.join('\n'), html };
}

const SAMPLE_LINE: InvoicingLine = {
    id: 1,
    kind: 'service',
    label: 'Refonte du site vitrine',
    description: 'Maquettes, intégration et mise en ligne.',
    quantityMilli: 3000,
    unit: 'day',
    unitPrice: 50_000,
    vatRateBp: 2000,
    netCents: 150_000
};

/** Une facture d'exemple, émise par un atelier fictif. */
function samplePaper(now: number): PaperInput {
    const day = (offset: number): string => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
    const totals = documentTotals([SAMPLE_LINE]);
    return {
        kind: 'invoice',
        numberLabel: 'F2026-0042',
        issuedOn: day(0),
        dueOn: day(30),
        validUntil: null,
        performedOn: day(-7),
        subject: 'Refonte du site vitrine',
        intro: '',
        notes: '',
        terms: '',
        purchaseOrder: '',
        currency: 'EUR',
        vatRegime: 'standard',
        issuer: {
            ...DEFAULT_SETTINGS.issuer,
            legalName: 'Atelier Exemple',
            address: '12 rue des Lilas',
            postalCode: '38000',
            city: 'Grenoble',
            siret: '81234567800017'
        },
        client: {
            name: 'Camille Martin',
            contactName: '',
            email: 'camille@exemple.fr',
            phone: '',
            address: '1 place du Marché',
            postalCode: '38000',
            city: 'Grenoble',
            country: 'France',
            siret: '',
            vatNumber: '',
            note: ''
        },
        wording: DEFAULT_SETTINGS.wording,
        lines: [SAMPLE_LINE],
        totals: { ...totals, vat: [...totals.vat] },
        settledCents: 0,
        remainingCents: totals.grossCents,
        deposit: null,
        deductions: [],
        parentNumber: null,
        awaitingAnswer: false,
        acceptedNote: null
    };
}

export const invoicingMailSamples: readonly SdkMailSample[] = [
    {
        key: 'document',
        label: 'Facture envoyée au client',
        sender: 'workspace',
        build: ({ now, origins }) =>
            documentMail({ paper: samplePaper(now), url: `${origins.public}/f/exemple`, message: '' })
    }
];

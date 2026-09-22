import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '../contracts/defaults';
import type { InvoicingLine } from '../contracts/domain';
import { documentTotals } from '../contracts/money';
import { escapeHtml, renderPaper, type PaperInput } from './paper';

/**
 * Le papier est le seul endroit où la conformité se joue : chaque mention
 * obligatoire y est vérifiée une par une, dans les trois types de document et
 * les deux régimes de TVA.
 */

function line(over: Partial<InvoicingLine> = {}): InvoicingLine {
    return {
        id: 1,
        kind: 'service',
        label: 'Développement',
        description: '',
        quantityMilli: 2000,
        unit: 'day',
        unitPrice: 50_000,
        vatRateBp: 2000,
        netCents: 100_000,
        ...over
    };
}

function paper(over: Partial<PaperInput> = {}): string {
    const lines = over.lines ?? [line()];
    const totals = documentTotals(
        lines.map((l) => ({
            kind: l.kind,
            quantityMilli: l.quantityMilli,
            unitPrice: l.unitPrice,
            vatRateBp: l.vatRateBp
        }))
    );
    return renderPaper({
        kind: 'invoice',
        numberLabel: 'F2026-0007',
        issuedOn: '2026-09-22',
        dueOn: '2026-10-22',
        validUntil: null,
        performedOn: '2026-09-08',
        subject: 'Refonte du site',
        intro: '',
        notes: '',
        terms: '',
        purchaseOrder: '4412',
        currency: 'EUR',
        vatRegime: 'standard',
        issuer: {
            ...DEFAULT_SETTINGS.issuer,
            legalName: 'Atelier Dupont',
            legalForm: 'SASU',
            capital: '1 000 €',
            address: '12 rue des Lilas',
            postalCode: '38000',
            city: 'Grenoble',
            siret: '81234567800017',
            rcs: 'RCS Grenoble 812 345 678',
            vatNumber: 'FR12812345678',
            iban: 'FR7630001007941234567890185',
            bic: 'BDFEFRPP',
            insurer: 'AXA',
            insuranceScope: 'France entière'
        },
        client: {
            name: 'Mairie de Nowhere',
            contactName: 'Service communication',
            email: '',
            phone: '',
            address: '1 place du Marché',
            postalCode: '38000',
            city: 'Grenoble',
            country: 'France',
            siret: '21380001700019',
            vatNumber: '',
            note: ''
        },
        wording: DEFAULT_SETTINGS.wording,
        lines,
        totals: { ...totals, vat: [...totals.vat] },
        settledCents: 0,
        remainingCents: totals.grossCents,
        deductions: [],
        parentNumber: null,
        awaitingAnswer: false,
        acceptedNote: null,
        ...over
    });
}

describe('escapeHtml', () => {
    it('neutralise ce qu’un nom pourrait porter', () => {
        assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
    });

    it('échappe les données du document, pas seulement sa structure', () => {
        const html = paper({ subject: 'Refonte <script>alert(1)</script>' });
        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });
});

describe('les mentions obligatoires d’une facture', () => {
    const html = paper();

    it('porte le mot FACTURE et son numéro', () => {
        assert.ok(html.includes('FACTURE'));
        assert.ok(html.includes('F2026-0007'));
    });

    it('identifie l’émetteur en entier', () => {
        for (const mention of [
            'Atelier Dupont',
            'SASU au capital de 1 000 €',
            '12 rue des Lilas',
            '38000 Grenoble',
            'SIRET 81234567800017',
            'RCS Grenoble 812 345 678',
            'TVA FR12812345678'
        ]) {
            assert.ok(html.includes(escapeHtml(mention)), `mention manquante : ${mention}`);
        }
    });

    it('identifie le client, SIRET compris', () => {
        assert.ok(html.includes('Mairie de Nowhere'));
        assert.ok(html.includes('1 place du Marché'.replace(/'/g, '&#39;')));
        assert.ok(html.includes('SIRET 21380001700019'));
    });

    it('porte les trois dates distinctes', () => {
        assert.ok(html.includes('Date d&#39;émission') || html.includes("Date d'émission"));
        assert.ok(html.includes('22 septembre 2026'));
        assert.ok(html.includes('Prestation réalisée le'));
        assert.ok(html.includes('8 septembre 2026'));
        assert.ok(html.includes('22 octobre 2026'));
    });

    it('porte l’objet et la référence de commande', () => {
        assert.ok(html.includes('Refonte du site'));
        assert.ok(html.includes('4412'));
    });

    it('détaille la ligne, sa quantité, son prix unitaire et son taux', () => {
        assert.ok(html.includes('Développement'));
        assert.ok(html.includes('2 jours'));
        assert.ok(html.includes('20 %'));
    });

    it('ventile la TVA par taux, puis donne les trois totaux', () => {
        assert.ok(html.includes('TVA 20 % sur'));
        assert.ok(html.includes('Total hors taxes'));
        assert.ok(html.includes('Total toutes taxes comprises'));
    });

    it('porte les conditions de règlement, l’IBAN, les pénalités et l’indemnité', () => {
        assert.ok(html.includes('FR7630001007941234567890185'));
        assert.ok(html.includes('BDFEFRPP'));
        assert.ok(html.includes(escapeHtml(DEFAULT_SETTINGS.wording.lateFeeText)));
        assert.ok(html.includes(escapeHtml(DEFAULT_SETTINGS.wording.recoveryFeeText)));
        assert.ok(html.includes('40'), 'l’indemnité forfaitaire est chiffrée');
    });

    it('porte l’assurance professionnelle', () => {
        assert.ok(html.includes('Assurance professionnelle : AXA (France entière)'));
    });
});

describe('les deux régimes de TVA', () => {
    it('en franchise, porte la mention et aucune colonne de taux', () => {
        const html = paper({ vatRegime: 'exempt', lines: [line({ vatRateBp: 0 })] });
        assert.ok(html.includes(escapeHtml('TVA non applicable, article 293 B du CGI.')));
        assert.ok(!html.includes('TVA 20 %'));
        assert.ok(!html.includes('Total toutes taxes comprises'));
        assert.ok(html.includes('Total à payer'));
    });

    it('assujetti, ne porte pas la mention d’exonération', () => {
        const html = paper();
        assert.ok(!html.includes('293 B'));
    });
});

describe('un devis', () => {
    const html = paper({
        kind: 'quote',
        numberLabel: 'D2026-0003',
        dueOn: null,
        validUntil: '2026-10-22',
        awaitingAnswer: true
    });

    it('porte le mot DEVIS, sa validité et le cadre de signature', () => {
        assert.ok(html.includes('DEVIS'));
        assert.ok(html.includes('Valable jusqu&#39;au') || html.includes("Valable jusqu'au"));
        assert.ok(html.includes(escapeHtml(DEFAULT_SETTINGS.wording.signatureText)));
        assert.ok(html.includes(escapeHtml(DEFAULT_SETTINGS.wording.quoteTerms)));
    });

    it('ne parle ni de pénalités de retard ni d’échéance', () => {
        assert.ok(!html.includes(escapeHtml(DEFAULT_SETTINGS.wording.lateFeeText)));
        assert.ok(!html.includes('À payer avant le'));
    });

    it('dit son acceptation en ligne, et retire alors le cadre de signature', () => {
        const accepted = paper({
            kind: 'quote',
            dueOn: null,
            validUntil: '2026-10-22',
            acceptedNote: 'Devis accepté en ligne le 23 septembre 2026 par Camille Martin.'
        });
        assert.ok(accepted.includes('accepté en ligne'));
        assert.ok(accepted.includes('Camille Martin'));
        // Les deux ensemble inviteraient à signer une seconde fois ce qui est
        // déjà accepté, et à côté de la ligne qui le dit.
        assert.ok(!accepted.includes(escapeHtml(DEFAULT_SETTINGS.wording.signatureText)));
        assert.ok(!accepted.includes('class="sign"'));
    });
});

describe('un avoir', () => {
    it('porte le mot AVOIR et la facture qu’il corrige', () => {
        const html = paper({ kind: 'credit', numberLabel: 'A2026-0001', parentNumber: 'F2026-0007', dueOn: null });
        assert.ok(html.includes('AVOIR'));
        assert.ok(html.includes('Annule la facture'));
        assert.ok(html.includes('F2026-0007'));
    });
});

describe('une facture entamée', () => {
    it('déduit l’acompte déjà facturé et dit le reste à payer', () => {
        const html = paper({
            deductions: [{ label: 'Acompte facturé (F2026-0003)', amountCents: 36_000 }],
            settledCents: 36_000,
            remainingCents: 84_000
        });
        assert.ok(html.includes('Acompte facturé (F2026-0003)'));
        assert.ok(html.includes('Déjà réglé'));
        assert.ok(html.includes('Reste à payer'));
    });
});

describe('la page elle-même', () => {
    it('est autonome : aucune ressource extérieure à charger', () => {
        const html = paper();
        assert.ok(!/<link\b/i.test(html), 'aucune feuille de style extérieure');
        assert.ok(!/<script\b/i.test(html), 'aucun script');
        assert.ok(html.includes('@page'), 'ses marges d’impression sont déclarées');
        assert.ok(html.includes('display: table-header-group'), 'l’en-tête du tableau se répète entre les pages');
    });
});

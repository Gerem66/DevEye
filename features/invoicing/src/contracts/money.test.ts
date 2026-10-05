import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INVOICING_QUANTITY_MILLI_MAX, INVOICING_UNIT_PRICE_MAX } from './domain';
import {
    depositTotals,
    documentTotals,
    lineNet,
    paymentVatCents,
    quoteDepositBp,
    remainingCents,
    type MoneyLine
} from './money';

/**
 * Le cœur calculatoire, et celui dont une erreur ne se verrait pas : le chiffre
 * reste plausible. Un centime d'écart entre le récapitulatif de TVA et le total
 * d'une facture est une facture fausse.
 */

function line(over: Partial<MoneyLine> = {}): MoneyLine {
    return { kind: 'service', quantityMilli: 1000, unitPrice: 0, vatRateBp: 2000, ...over };
}

describe('lineNet', () => {
    it('rend le prix unitaire pour une unité', () => {
        assert.equal(lineNet(line({ unitPrice: 45_000 })), 45_000);
    });

    it('compte une demi-journée', () => {
        assert.equal(lineNet(line({ quantityMilli: 500, unitPrice: 40_000 })), 20_000);
    });

    it('arrondit le demi vers le haut', () => {
        // 1,333 h à 75,00 € vaut 99,975 € : 99,98 € et non 99,97 €.
        assert.equal(lineNet(line({ quantityMilli: 1333, unitPrice: 7500 })), 9998);
    });

    it('rend zéro pour une quantité nulle', () => {
        assert.equal(lineNet(line({ quantityMilli: 0, unitPrice: 45_000 })), 0);
    });

    it('ignore une ligne de commentaire, même chiffrée par erreur', () => {
        assert.equal(lineNet(line({ kind: 'text', quantityMilli: 1000, unitPrice: 45_000 })), 0);
    });

    it('reste exact aux plafonds du domaine', () => {
        const net = lineNet(line({ quantityMilli: INVOICING_QUANTITY_MILLI_MAX, unitPrice: INVOICING_UNIT_PRICE_MAX }));
        assert.equal(net, 100_000_000_000);
        assert.ok(Number.isSafeInteger(net));
    });
});

describe('documentTotals', () => {
    it('somme les lignes et ajoute la TVA', () => {
        const totals = documentTotals([
            line({ quantityMilli: 2000, unitPrice: 50_000, vatRateBp: 2000 }),
            line({ quantityMilli: 1000, unitPrice: 20_000, vatRateBp: 2000 })
        ]);
        assert.equal(totals.netCents, 120_000);
        assert.equal(totals.vatCents, 24_000);
        assert.equal(totals.grossCents, 144_000);
        assert.deepEqual(totals.vat, [{ rateBp: 2000, netCents: 120_000, vatCents: 24_000 }]);
    });

    it('range les tranches du taux le plus élevé au plus bas', () => {
        const totals = documentTotals([
            line({ unitPrice: 10_000, vatRateBp: 550 }),
            line({ unitPrice: 10_000, vatRateBp: 2000 }),
            line({ unitPrice: 10_000, vatRateBp: 0 })
        ]);
        assert.deepEqual(
            totals.vat.map((share) => share.rateBp),
            [2000, 550, 0]
        );
    });

    it('calcule la TVA par taux sur la base agrégée, pas ligne par ligne', () => {
        // Deux lignes à 0,05 € : ligne par ligne, chaque part de TVA à 20 %
        // vaudrait 1 centime (0,01 arrondi), soit 2 centimes en tout. Sur la
        // base agrégée de 0,10 €, elle vaut 2 centimes aussi, mais avec trois
        // lignes l'écart apparaîtrait. Ce que le document imprime est la
        // ventilation, donc c'est elle qui fait foi.
        const totals = documentTotals([
            line({ unitPrice: 5, vatRateBp: 2000 }),
            line({ unitPrice: 5, vatRateBp: 2000 }),
            line({ unitPrice: 5, vatRateBp: 2000 })
        ]);
        assert.equal(totals.netCents, 15);
        assert.equal(totals.vatCents, 3);
        assert.equal(totals.vat[0].vatCents, 3);
    });

    it('garde la somme des tranches égale au total de TVA', () => {
        const totals = documentTotals([
            line({ quantityMilli: 1333, unitPrice: 7500, vatRateBp: 2000 }),
            line({ quantityMilli: 333, unitPrice: 1299, vatRateBp: 550 }),
            line({ quantityMilli: 7000, unitPrice: 111, vatRateBp: 1000 }),
            line({ quantityMilli: 1000, unitPrice: 9999, vatRateBp: 210 })
        ]);
        const sum = totals.vat.reduce((total, share) => total + share.vatCents, 0);
        assert.equal(sum, totals.vatCents);
        assert.equal(
            totals.vat.reduce((total, share) => total + share.netCents, 0),
            totals.netCents
        );
        assert.equal(totals.grossCents, totals.netCents + totals.vatCents);
    });

    it('ne compte pas les commentaires dans la ventilation', () => {
        const totals = documentTotals([
            line({ unitPrice: 10_000, vatRateBp: 2000 }),
            line({ kind: 'text', unitPrice: 0, vatRateBp: 550 })
        ]);
        assert.equal(totals.vat.length, 1);
        assert.equal(totals.netCents, 10_000);
    });

    it('rend des totaux nuls sans ligne', () => {
        assert.deepEqual(documentTotals([]), { netCents: 0, vatCents: 0, grossCents: 0, vat: [] });
    });

    it('laisse la TVA à zéro en franchise de base', () => {
        const totals = documentTotals([line({ unitPrice: 120_000, vatRateBp: 0 })]);
        assert.equal(totals.vatCents, 0);
        assert.equal(totals.grossCents, 120_000);
    });
});

describe('depositTotals', () => {
    it('prend la part de chaque taux, puis calcule la taxe sur ces bases', () => {
        const quote = documentTotals([
            line({ unitPrice: 100_000, vatRateBp: 2000 }),
            line({ unitPrice: 33_333, vatRateBp: 550 })
        ]);
        const deposit = depositTotals(quote, 3000);
        assert.deepEqual(
            deposit.vat.map((share) => [share.rateBp, share.netCents]),
            [
                [2000, 30_000],
                [550, 10_000]
            ]
        );
        assert.equal(deposit.grossCents, 30_000 + 6_000 + 10_000 + 550);
    });

    it('écarte un taux dont la part arrondit à zéro', () => {
        const quote = documentTotals([line({ unitPrice: 100_000 }), line({ unitPrice: 1, vatRateBp: 550 })]);
        assert.equal(depositTotals(quote, 1000).vat.length, 1);
    });
});

describe('quoteDepositBp', () => {
    it('suit le réglage tant que le devis est un brouillon sans part à lui', () => {
        assert.equal(quoteDepositBp({ kind: 'quote', status: 'draft', depositBp: null }, 3000), 3000);
        assert.equal(quoteDepositBp({ kind: 'quote', status: 'draft', depositBp: 0 }, 3000), 0);
        assert.equal(quoteDepositBp({ kind: 'quote', status: 'draft', depositBp: 4000 }, 3000), 4000);
    });

    it('ne lit plus le réglage une fois le devis émis', () => {
        assert.equal(quoteDepositBp({ kind: 'quote', status: 'sent', depositBp: null }, 3000), 0);
        assert.equal(quoteDepositBp({ kind: 'quote', status: 'accepted', depositBp: 2000 }, 3000), 2000);
    });

    it('vaut zéro hors devis', () => {
        assert.equal(quoteDepositBp({ kind: 'invoice', status: 'draft', depositBp: null }, 3000), 0);
    });
});

describe('remainingCents', () => {
    const base = { grossCents: 120_000, paidCents: 0, creditedCents: 0, deductedCents: 0 };

    it('rend le total quand rien n’est réglé', () => {
        assert.equal(remainingCents(base), 120_000);
    });

    it('déduit un règlement partiel', () => {
        assert.equal(remainingCents({ ...base, paidCents: 50_000 }), 70_000);
    });

    it('déduit un avoir comme un règlement', () => {
        assert.equal(remainingCents({ ...base, creditedCents: 120_000 }), 0);
    });

    it('déduit un acompte déjà facturé', () => {
        assert.equal(remainingCents({ ...base, deductedCents: 36_000, paidCents: 84_000 }), 0);
    });

    it('ne descend jamais sous zéro', () => {
        assert.equal(remainingCents({ ...base, paidCents: 150_000 }), 0);
    });
});

describe('paymentVatCents', () => {
    it('rend toute la taxe pour un règlement du total', () => {
        assert.equal(paymentVatCents(120_000, 20_000, 120_000), 20_000);
    });

    it('prend la fraction d’un acompte, le demi vers le haut', () => {
        // 1/3 de 20,00 € = 6,666… : 6,67 €.
        assert.equal(paymentVatCents(40_000, 20_000, 120_000), 6_667);
        // Sur 100 € TTC dont 10 € de taxe : 25 centimes en portent 2,5, arrondis à 3 ;
        // 24 centimes en portent 2,4, arrondis à 2.
        assert.equal(paymentVatCents(25, 1_000, 10_000), 3);
        assert.equal(paymentVatCents(24, 1_000, 10_000), 2);
    });

    it('vaut zéro sans taxe ou sans total', () => {
        assert.equal(paymentVatCents(10_000, 0, 10_000), 0);
        assert.equal(paymentVatCents(10_000, 2_000, 0), 0);
    });

    it('ne perd rien sur des montants plafonnés', () => {
        const max = INVOICING_UNIT_PRICE_MAX;
        assert.equal(paymentVatCents(max, max, max), max);
    });
});

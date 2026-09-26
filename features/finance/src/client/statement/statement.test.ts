import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeLabel } from '../../contracts/statement';
import { csvLines, decodeStatement, guessMapping, parseCsvTable, parseDay, parseMoney } from './csv';
import { ruleKeyword } from './keyword';
import { looksLikeOfx, parseOfx } from './ofx';

/** Les relevés tels que les banques les écrivent vraiment : c'est leur désordre qui se teste. */

describe('parseMoney', () => {
    it('lit les écritures françaises et anglaises', () => {
        assert.equal(parseMoney('1 234,56'), 123_456);
        assert.equal(parseMoney('-12,30'), -1_230);
        assert.equal(parseMoney('12.30'), 1_230);
        assert.equal(parseMoney('1,234.56'), 123_456);
        assert.equal(parseMoney('1.234,56'), 123_456);
        assert.equal(parseMoney('(12,30)'), -1_230);
        assert.equal(parseMoney('12,30-'), -1_230);
        assert.equal(parseMoney('+45,00 €'), 4_500);
        assert.equal(parseMoney('1 200,00 EUR'), 120_000);
    });

    it('refuse ce qui n’est pas un montant', () => {
        assert.equal(parseMoney(''), null);
        assert.equal(parseMoney('PRLV SEPA'), null);
        assert.equal(parseMoney('15/09/2026'), null);
    });
});

describe('parseDay', () => {
    it('lit le jour d’abord, l’année en tête, ou collée', () => {
        assert.equal(parseDay('15/09/2026'), '2026-09-15');
        assert.equal(parseDay('15-09-26'), '2026-09-15');
        assert.equal(parseDay('2026-09-15'), '2026-09-15');
        assert.equal(parseDay('20260915'), '2026-09-15');
        assert.equal(parseDay('09/15/2026', false), '2026-09-15');
    });

    it('refuse une date qui n’existe pas', () => {
        assert.equal(parseDay('31/02/2026'), null);
        assert.equal(parseDay('Compte courant'), null);
    });
});

describe('un CSV à la française', () => {
    // Windows-1252, deux lignes d'en-tête parasites, point-virgule, virgule décimale, un solde.
    const text = [
        'Compte courant n° 12345;;;;',
        'Solde au 30/09/2026;;;;2 410,00',
        'Date;Date de valeur;Libellé;Montant;Solde',
        '28/09/2026;28/09/2026;PRLV SEPA OVH SAS;-23,99;2 410,00',
        '25/09/2026;25/09/2026;"VIR DUPONT; FACTURE F2026-0007";1 200,00;2 433,99',
        '20/09/2026;20/09/2026;CB RESTAURANT LE ZINC;-45,50;1 233,99',
        'Total;;;1 130,51;'
    ].join('\r\n');

    it('décode le Windows-1252, écarte l’avant-en-tête et devine les colonnes', () => {
        const bytes = Uint8Array.from(text, (c) => (c === '°' ? 0xb0 : c.charCodeAt(0)));
        const table = parseCsvTable(decodeStatement(bytes));
        assert.ok(table);
        assert.equal(table.separator, ';');
        assert.deepEqual(table.header, ['Date', 'Date de valeur', 'Libellé', 'Montant', 'Solde']);
        const mapping = guessMapping(table);
        assert.equal(mapping.date, 0, 'la date d’opération, pas celle de valeur');
        assert.deepEqual(mapping.label, [2]);
        assert.equal(mapping.amount, 3);
        assert.equal(mapping.balance, 4);
    });

    it('rend les lignes, le sens, et le solde de la plus récente', () => {
        const table = parseCsvTable(text);
        assert.ok(table);
        const parsed = csvLines(table, guessMapping(table));
        assert.equal(parsed.lines.length, 3);
        assert.equal(parsed.skipped, 1, 'la ligne de total');
        assert.deepEqual(parsed.lines[0], {
            date: '2026-09-28',
            direction: 'out',
            amount: 2_399,
            label: 'PRLV SEPA OVH SAS',
            memo: '',
            fitid: null
        });
        assert.equal(parsed.lines[1].label, 'VIR DUPONT; FACTURE F2026-0007');
        assert.equal(parsed.lines[1].direction, 'in');
        assert.deepEqual(parsed.closing, { balance: 241_000, date: '2026-09-28' });
    });
});

describe('un CSV en débit et crédit', () => {
    it('prend le sens de la colonne, quel que soit le signe écrit', () => {
        const text = [
            'Date,Description,Debit,Credit',
            '2026-09-01,Stripe payout,,350.00',
            '2026-09-02,GitHub,-4.00,',
            '2026-09-03,Hetzner,12.50,'
        ].join('\n');
        const table = parseCsvTable(text);
        assert.ok(table);
        const mapping = guessMapping(table);
        assert.equal(mapping.debit, 2);
        assert.equal(mapping.credit, 3);
        const { lines } = csvLines(table, mapping);
        assert.deepEqual(
            lines.map((l) => [l.direction, l.amount]),
            [
                ['in', 35_000],
                ['out', 400],
                ['out', 1_250]
            ]
        );
    });
});

describe('OFX', () => {
    it('lit la première génération, en SGML', () => {
        const text = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260928120000[+1:CET]<TRNAMT>-23.99<FITID>A1B2<NAME>PRLV SEPA OVH SAS<MEMO>Facture 1234
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260925<TRNAMT>1200,00<FITID>C3D4<NAME>VIR DUPONT &amp; FILS
</BANKTRANLIST><LEDGERBAL><BALAMT>2410.00<DTASOF>20260930</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
        assert.equal(looksLikeOfx(text), true);
        const parsed = parseOfx(text);
        assert.deepEqual(parsed.lines, [
            {
                date: '2026-09-28',
                direction: 'out',
                amount: 2_399,
                label: 'PRLV SEPA OVH SAS',
                memo: 'Facture 1234',
                fitid: 'A1B2'
            },
            {
                date: '2026-09-25',
                direction: 'in',
                amount: 120_000,
                label: 'VIR DUPONT & FILS',
                memo: '',
                fitid: 'C3D4'
            }
        ]);
        assert.deepEqual(parsed.closing, { balance: 241_000, date: '2026-09-30' });
    });

    it('lit la seconde, en XML', () => {
        const text = `<?xml version="1.0"?><OFX><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260901</DTPOSTED><TRNAMT>-9.99</TRNAMT><FITID>X9</FITID><NAME>Figma</NAME></STMTTRN>
</BANKTRANLIST></OFX>`;
        const parsed = parseOfx(text);
        assert.equal(parsed.lines.length, 1);
        assert.equal(parsed.lines[0].label, 'Figma');
        assert.equal(parsed.lines[0].fitid, 'X9');
        assert.equal(parsed.closing, null);
    });
});

describe('normalizeLabel', () => {
    it('ignore la casse, les accents et les espaces en trop', () => {
        assert.equal(normalizeLabel('  PRLV  Été\tOVH '), 'prlv ete ovh');
    });
});

describe('ruleKeyword', () => {
    it('garde le nom de qui a été payé, sans les mots de la banque', () => {
        assert.equal(ruleKeyword('PRLV SEPA OVH SAS'), 'ovh');
        assert.equal(ruleKeyword('CB LDLC 12/09'), 'ldlc');
        assert.equal(ruleKeyword('VIR SEPA RECU /DE ACME CORP /MOTIF F2026-0007'), 'acme');
        assert.equal(ruleKeyword('CARTE 4X12 12/09'), '');
    });
});

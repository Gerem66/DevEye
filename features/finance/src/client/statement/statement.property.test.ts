import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { FINANCE_AMOUNT_MAX } from '../../contracts/domain';
import {
    STATEMENT_LABEL_MAX_LENGTH,
    statementClosingSchema,
    statementLineInputSchema,
    type StatementLineInput
} from '../../contracts/statement';
import {
    columnCount,
    columnName,
    csvLines,
    decodeStatement,
    guessMapping,
    headerSignature,
    parseCsvTable,
    parseDay,
    parseMoney,
    type CsvMapping,
    type ParsedStatement
} from './csv';
import { looksLikeOfx, parseOfx } from './ofx';

/**
 * Un relevé vient d'une banque qu'on ne connaît pas, ou d'un fichier qui n'en
 * est pas un. Ce que le navigateur en tire part au serveur : le contrat de la
 * commande est l'arbitre, une ligne qu'il refuserait ferait échouer l'import
 * entier d'un fichier pourtant lu.
 */

function assertSendable(statement: ParsedStatement): void {
    for (const line of statement.lines) {
        const verdict = statementLineInputSchema.safeParse(line);
        assert.ok(verdict.success, `ligne refusée par le contrat : ${JSON.stringify(line)}`);
        assert.ok(isRealDay(line.date), `jour inexistant : ${line.date}`);
    }
    if (statement.closing !== null) {
        assert.ok(statementClosingSchema.safeParse(statement.closing).success, JSON.stringify(statement.closing));
        assert.ok(isRealDay(statement.closing.date));
    }
}

const isRealDay = (iso: string): boolean => {
    const at = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === iso;
};

const day = fc
    .date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true })
    .map((at) => at.toISOString().slice(0, 10));

/** Le même jour, tel que des banques l'écrivent. Rend aussi le sens de lecture qu'il suppose. */
const writtenDay = fc
    .tuple(day, fc.constantFrom('dmy/', 'dmy-', 'dmy.', 'dmy2', 'mdy', 'iso', 'iso/', 'compact', 'isoTime'))
    .map(([iso, style]) => {
        const [y, m, d] = iso.split('-');
        const texts: Record<string, string> = {
            'dmy/': `${d}/${m}/${y}`,
            'dmy-': `${Number(d)}-${Number(m)}-${y}`,
            'dmy.': `${d}.${m}.${y}`,
            dmy2: `${d}/${m}/${y.slice(2)}`,
            mdy: `${m}/${d}/${y}`,
            iso,
            'iso/': `${y}/${m}/${d}`,
            compact: `${y}${m}${d}`,
            isoTime: `${iso}T12:30:00`
        };
        // Une année à deux chiffres se lit dans le siècle courant.
        const expected = style === 'dmy2' ? `20${y.slice(2)}-${m}-${d}` : iso;
        return { text: texts[style], dayFirst: style !== 'mdy', iso: expected };
    });

const cents = fc.integer({ min: 1, max: 10_000_000_000_000 });

/** Le même montant, tel que des banques l'écrivent. */
const writtenMoney = fc
    .tuple(
        cents,
        fc.boolean(),
        fc.constantFrom('fr', 'frNarrow', 'de', 'en', 'comma', 'dot'),
        fc.constantFrom('lead', 'trail', 'paren'),
        fc.constantFrom('', ' €', ' EUR', '$')
    )
    .map(([amount, negative, style, sign, currency]) => {
        const units = String(Math.floor(amount / 100));
        const decimals = String(amount % 100).padStart(2, '0');
        const grouped = (separator: string): string => units.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
        const bodies: Record<string, string> = {
            fr: `${grouped(' ')},${decimals}`,
            frNarrow: `${grouped(' ')},${decimals}`,
            de: `${grouped('.')},${decimals}`,
            en: `${grouped(',')}.${decimals}`,
            comma: `${units},${decimals}`,
            dot: `${units}.${decimals}`
        };
        const body = bodies[style] + currency;
        const signed = !negative ? body : sign === 'lead' ? `-${body}` : sign === 'trail' ? `${body}-` : `(${body})`;
        return { text: signed, cents: negative ? -amount : amount };
    });

const word = fc.oneof(
    fc.constantFrom('PRLV SEPA OVH', 'CB CAFE', 'Virement reçu', 'Total', '', 'Été à Paris', 'a "b" c'),
    fc.string({ maxLength: 12 })
);

/** Ce qu'une cellule peut porter, du plausible à l'absurde. */
const cell = fc.oneof(
    { weight: 3, arbitrary: writtenDay.map((written) => written.text) },
    { weight: 3, arbitrary: writtenMoney.map((written) => written.text) },
    { weight: 2, arbitrary: word },
    {
        weight: 1,
        arbitrary: fc.constantFrom(
            '0',
            '0,00',
            '-0,00',
            '99999999999999999999999999',
            '9'.repeat(400),
            '0000-01-01',
            '01/01/0026',
            '31/02/2026',
            '00/00/0000',
            '99/99/9999',
            '1e5',
            '--5',
            '()',
            '"',
            '""'
        )
    }
);

const csvText = fc
    .tuple(
        fc.constantFrom(';', ',', '\t', '|'),
        fc.constantFrom('\n', '\r\n', '\r'),
        fc.option(
            fc.constantFrom(
                ['Date', 'Libellé', 'Montant', 'Solde'],
                ['Date opération', 'Date valeur', 'Détail', 'Débit', 'Crédit'],
                ['date', 'amount', 'payee'],
                ['x', 'y']
            ),
            { nil: null }
        ),
        fc.array(fc.array(cell, { maxLength: 6 }), { maxLength: 12 }),
        fc.array(word, { maxLength: 2 })
    )
    .map(([separator, newline, header, rows, preamble]) =>
        [...preamble, ...(header ? [header.join(separator)] : []), ...rows.map((row) => row.join(separator))].join(
            newline
        )
    );

describe('un montant écrit par une banque', () => {
    it('se relit au centime, quels que soient le signe, les milliers et la devise', () => {
        fc.assert(
            fc.property(writtenMoney, (written) => {
                assert.equal(parseMoney(written.text), written.cents, written.text);
            })
        );
    });

    it('vaut null ou un nombre entier de centimes, jamais autre chose', () => {
        const text = fc.oneof(
            cell,
            fc
                .tuple(fc.bigInt({ min: 0n, max: 10n ** 40n }), fc.constantFrom('', ',5', '.50', ',123', '-'))
                .map(([digits, tail]) => `${digits}${tail}`),
            fc
                .array(fc.constantFrom('0', '1', '9', ',', '.', '-', '+', '(', ')', ' ', '€', 'EUR', 'e', '\u00a0'), {
                    maxLength: 30
                })
                .map((parts) => parts.join(''))
        );
        fc.assert(
            fc.property(text, (value) => {
                const amount = parseMoney(value);
                assert.ok(
                    amount === null || (Number.isSafeInteger(amount) && Math.abs(amount) <= FINANCE_AMOUNT_MAX),
                    `${JSON.stringify(value)} : ${amount}`
                );
            })
        );
    });
});

describe('un jour écrit par une banque', () => {
    it('se relit dans chaque écriture courante', () => {
        fc.assert(
            fc.property(writtenDay, (written) => {
                assert.equal(parseDay(written.text, written.dayFirst), written.iso, written.text);
            })
        );
    });

    it('vaut null ou un jour qui existe, écrit AAAA-MM-JJ', () => {
        const text = fc.oneof(
            cell,
            fc.stringMatching(/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/),
            fc.stringMatching(/^\d{8}$/),
            fc
                .array(fc.constantFrom('0', '1', '2', '3', '9', '/', '-', '.', ' ', 'T'), { maxLength: 14 })
                .map((parts) => parts.join(''))
        );
        fc.assert(
            fc.property(text, fc.boolean(), (value, dayFirst) => {
                const iso = parseDay(value, dayFirst);
                assert.ok(iso === null || (/^\d{4}-\d{2}-\d{2}$/.test(iso) && isRealDay(iso)), `${value} : ${iso}`);
            })
        );
    });
});

describe('un fichier CSV quelconque', () => {
    it('donne des lignes que le serveur accepte, avec la correspondance devinée', () => {
        fc.assert(
            fc.property(csvText, (text) => {
                const table = parseCsvTable(text);
                if (table === null) return;
                const width = columnCount(table);
                const mapping = guessMapping(table);
                for (const index of [mapping.date, ...mapping.label]) assert.ok(index >= 0 && index < width);
                for (const index of [mapping.amount, mapping.debit, mapping.credit, mapping.balance]) {
                    assert.ok(index === null || (index >= 0 && index < width));
                }
                const statement = csvLines(table, mapping);
                assert.equal(statement.lines.length + statement.skipped, table.rows.length);
                assertSendable(statement);
                assert.equal(typeof headerSignature(table), 'string');
                assert.equal(typeof columnName(table, width), 'string');
            })
        );
    });

    it('donne des lignes que le serveur accepte, avec une correspondance retenue pour un autre fichier', () => {
        const column = fc.nat(8);
        const mapping: fc.Arbitrary<CsvMapping> = fc.record({
            date: column,
            label: fc.array(column, { maxLength: 8 }),
            amount: fc.option(column, { nil: null }),
            debit: fc.option(column, { nil: null }),
            credit: fc.option(column, { nil: null }),
            balance: fc.option(column, { nil: null }),
            dayFirst: fc.boolean()
        });
        fc.assert(
            fc.property(csvText, mapping, (text, stored) => {
                const table = parseCsvTable(text);
                if (table !== null) assertSendable(csvLines(table, stored));
            })
        );
    });

    it('rend ses cellules telles qu’écrites : séparateur, guillemets et retours à la ligne entre guillemets', () => {
        const rows = fc.array(
            fc.tuple(
                day,
                cents,
                fc.boolean(),
                fc.array(fc.constantFrom('a', 'É', ' ', '"', '\n', '\r\n', 'SEP', 'x1'), { maxLength: 8 })
            ),
            { minLength: 1, maxLength: 10 }
        );
        fc.assert(
            fc.property(
                fc.constantFrom(';', ',', '\t', '|'),
                fc.constantFrom('\n', '\r\n'),
                rows,
                (separator, newline, drawn) => {
                    const expected = drawn.map(([iso, amount, negative, parts]) => ({
                        iso,
                        signed: negative ? -amount : amount,
                        label: parts.join('').replace(/SEP/g, separator)
                    }));
                    const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
                    const text = expected
                        .map(({ iso, signed, label }) => {
                            const [y, m, d] = iso.split('-');
                            const money = `${signed < 0 ? '-' : ''}${Math.floor(Math.abs(signed) / 100)},${String(Math.abs(signed) % 100).padStart(2, '0')}`;
                            return [`${d}/${m}/${y}`, quote(label), quote(money)].join(separator);
                        })
                        .join(newline);

                    const table = parseCsvTable(text);
                    assert.ok(table);
                    assert.equal(table.separator, separator);
                    const statement = csvLines(table, {
                        date: 0,
                        label: [1],
                        amount: 2,
                        debit: null,
                        credit: null,
                        balance: null,
                        dayFirst: true
                    });
                    assert.deepEqual(
                        statement.lines,
                        expected.map(({ iso, signed, label }): StatementLineInput => ({
                            date: iso,
                            direction: signed < 0 ? 'out' : 'in',
                            amount: Math.abs(signed),
                            label: label.trim().slice(0, STATEMENT_LABEL_MAX_LENGTH),
                            memo: '',
                            fitid: null
                        }))
                    );
                }
            )
        );
    });

    it('se lit en un temps proportionnel à sa taille, cellules pleines de guillemets comprises', () => {
        const timed = (text: string): number => {
            const started = performance.now();
            parseCsvTable(text);
            return performance.now() - started;
        };
        const row = (cell: string): string => `01/02/2026;${cell};12,30\n`;
        // Mesuré contre le même fichier sans guillemets : la machine et sa charge comptent des deux côtés.
        const plain = timed(row(`a${'x'.repeat(200_000)}`).repeat(4));
        const quotes = timed(row(`a${'"'.repeat(200_000)}`).repeat(4));
        assert.ok(quotes < 20 * plain + 500, `${Math.round(quotes)} ms, contre ${Math.round(plain)} ms`);
    });

    it('se lit encore quand il compte des centaines de milliers de lignes', () => {
        const table = parseCsvTable('01/02/2026;CB CAFE;-2,50\n'.repeat(400_000));
        assert.ok(table);
        assert.equal(columnCount(table), 3);
        assert.equal(csvLines(table, guessMapping(table)).lines.length, 400_000);
    });
});

describe('un fichier OFX quelconque', () => {
    const tag = fc.constantFrom(
        'OFX',
        'STMTTRN',
        '/STMTTRN',
        'BANKTRANLIST',
        '/BANKTRANLIST',
        'DTPOSTED',
        '/DTPOSTED',
        'TRNAMT',
        'NAME',
        'MEMO',
        'FITID',
        'LEDGERBAL',
        '/LEDGERBAL',
        'BALAMT',
        'DTASOF',
        'AVAILBAL',
        'stmttrn',
        'trnamt'
    );
    const value = fc.oneof(
        writtenMoney.map((written) => written.text),
        day.map((iso) => `${iso.replace(/-/g, '')}120000[+1:CET]`),
        cell,
        fc.constantFrom('00000000', '20261332', '00001301', '&amp;&lt;&gt;&quot;&apos;&amp;amp;', 'x'.repeat(500))
    );
    const ofxText = fc
        .array(
            fc.oneof(
                fc.tuple(tag, value).map(([name, text]) => `<${name}>${text}`),
                fc.constantFrom('\n', '\r\n', ' ', '<', '>', 'OFXHEADER:100')
            ),
            {
                maxLength: 40
            }
        )
        .map((parts) => parts.join(''));

    it('donne des lignes que le serveur accepte', () => {
        fc.assert(
            fc.property(ofxText, (text) => {
                assert.equal(typeof looksLikeOfx(text), 'boolean');
                const statement = parseOfx(text);
                assertSendable(statement);
                for (const line of statement.lines) assert.notEqual(line.fitid, '');
            })
        );
    });

    it('rend les mouvements qu’on y écrit, en SGML comme en XML', () => {
        const text = fc.stringMatching(/^[A-Za-z0-9 &'"é.-]{1,40}$/).map((raw) => raw.trim());
        const movement = fc.record({
            iso: day,
            amount: cents,
            negative: fc.boolean(),
            name: text,
            memo: text,
            fitid: fc.stringMatching(/^[A-Za-z0-9]{1,20}$/)
        });
        const escape = (raw: string): string => raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        fc.assert(
            fc.property(fc.array(movement, { maxLength: 8 }), fc.boolean(), (movements, xml) => {
                const leaf = (name: string, content: string): string =>
                    xml ? `<${name}>${escape(content)}</${name}>` : `<${name}>${escape(content)}\n`;
                const body = movements
                    .map(({ iso, amount, negative, name, memo, fitid }) =>
                        [
                            '<STMTTRN>',
                            leaf('TRNTYPE', negative ? 'DEBIT' : 'CREDIT'),
                            leaf('DTPOSTED', `${iso.replace(/-/g, '')}120000[+1:CET]`),
                            leaf(
                                'TRNAMT',
                                `${negative ? '-' : ''}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`
                            ),
                            leaf('FITID', fitid),
                            leaf('NAME', name),
                            leaf('MEMO', memo),
                            '</STMTTRN>'
                        ].join('')
                    )
                    .join('\n');
                const statement = parseOfx(`OFXHEADER:100\n<OFX><BANKTRANLIST>${body}</BANKTRANLIST></OFX>`);
                assert.deepEqual(
                    statement.lines,
                    movements.map(({ iso, amount, negative, name, memo, fitid }): StatementLineInput => ({
                        date: iso,
                        direction: negative ? 'out' : 'in',
                        amount,
                        label: name || memo,
                        memo: name ? memo : '',
                        fitid
                    }))
                );
            })
        );
    });
});

describe('les octets d’un relevé', () => {
    it('se décodent toujours : UTF-8 quand c’en est, Windows-1252 sinon', () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
                assert.equal(typeof decodeStatement(bytes), 'string');
            })
        );
        fc.assert(
            fc.property(fc.string({ unit: 'grapheme', maxLength: 60 }), fc.boolean(), (text, bom) => {
                fc.pre(!text.startsWith('﻿'));
                const encoded = Buffer.from((bom ? '﻿' : '') + text, 'utf8');
                assert.equal(decodeStatement(encoded), text);
            })
        );
    });
});

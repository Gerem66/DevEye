import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { CommandReader, parseCommand, ParseError, type Segment, type Token } from './parser';
import { compactUids, inSequenceSet, parseSequenceSet } from './sequence';
import { decodeUtf7, encodeUtf7 } from './utf7';
import { atom, formatInternalDate, formatLine, parseImapDate, type ImapValue } from './wire';

/**
 * Ce qu'un client hostile envoie n'a pas de forme : ces propriétés tirent des
 * flux au hasard, au lieu des quelques cas qu'on pense à écrire.
 */

const SMALL = { maxLine: 64, maxLiteral: 32 };
const WIDE = { maxLine: 1 << 20, maxLiteral: 1 << 20 };

/** Ce qui casse une commande : délimiteurs seuls, littéraux annoncés sans suite, octets quelconques. */
const noise = fc.oneof(
    fc.constantFrom(
        ' ',
        '(',
        ')',
        '"',
        '\\',
        '[',
        ']',
        '{3}\r\n',
        '{3+}\r\n',
        '{0}\r\n',
        '{40}\r\n',
        '{999999999}\r\n',
        '\r\n',
        '\n',
        '\r'
    ),
    fc.string({ unit: 'binary-ascii', maxLength: 12 }),
    fc.uint8Array({ maxLength: 24 }).map((bytes) => Buffer.from(bytes).toString('latin1'))
);

const word = fc.stringMatching(/^[A-Za-z0-9.*:]{1,8}$/);
const { argument } = fc.letrec<{ argument: string }>((tie) => ({
    argument: fc.oneof(
        { maxDepth: 3 },
        word,
        fc
            .string({ unit: 'binary-ascii', maxLength: 10 })
            .map((text) => `"${text.replace(/[\r\n]/g, '').replace(/[\\"]/g, '\\$&')}"`),
        fc
            .tuple(fc.uint8Array({ maxLength: 36 }), fc.boolean())
            .map(([bytes, plus]) => `{${bytes.length}${plus ? '+' : ''}}\r\n${Buffer.from(bytes).toString('latin1')}`),
        fc.array(tie('argument'), { maxLength: 3 }).map((items) => `(${items.join(' ')})`),
        fc.constantFrom('BODY.PEEK[HEADER.FIELDS (DATE FROM)]<0.100>', 'BODY[1.2.TEXT]', '1:*', 'NIL')
    )
}));
/** Une commande bien formée : sans elles, le hasard n'atteint presque jamais un littéral. */
const command = fc
    .tuple(word, word, fc.array(argument, { maxLength: 4 }))
    .map(([tag, name, args]) => `${[tag, name, ...args].join(' ')}\r\n`);

const fragment = fc.oneof({ weight: 4, arbitrary: command }, { weight: 1, arbitrary: noise });
const stream = fc.array(fragment, { maxLength: 12 }).map((parts) => Buffer.from(parts.join(''), 'latin1'));

/** Ce que le lecteur dit d'un flux coupé à ces endroits. */
function events(bytes: Buffer, cuts: readonly number[], limits = SMALL): string[] {
    const log: string[] = [];
    const reader = new CommandReader(limits, {
        onLine: (segments) =>
            log.push(`line ${JSON.stringify(segments.map((s) => (typeof s === 'string' ? s : [s.toString('hex')])))}`),
        onContinue: () => log.push('continue'),
        onOverflow: (reason) => log.push(`overflow ${reason}`)
    });
    let from = 0;
    for (const cut of [...cuts, bytes.length]) {
        reader.feed(bytes.subarray(from, cut));
        from = cut;
    }
    return log;
}

const cutsOf = (bytes: Buffer) =>
    fc.array(fc.integer({ min: 0, max: bytes.length }), { maxLength: 12 }).map((cuts) => cuts.sort((a, b) => a - b));

describe('CommandReader, sur un flux quelconque', () => {
    it('lit la même chose quel que soit le découpage du flux', () => {
        fc.assert(
            fc.property(
                stream.chain((bytes) => fc.tuple(fc.constant(bytes), cutsOf(bytes))),
                ([bytes, cuts]) => {
                    assert.deepEqual(events(bytes, cuts), events(bytes, []));
                    // Octet par octet : le pire découpage.
                    assert.deepEqual(
                        events(
                            bytes,
                            Array.from({ length: bytes.length }, (_, i) => i)
                        ),
                        events(bytes, [])
                    );
                }
            )
        );
    });

    it('ne rend jamais une ligne ni un littéral au-delà de ses bornes, et se tait après un dépassement', () => {
        fc.assert(
            fc.property(stream, (bytes) => {
                const segments: Segment[] = [];
                let overflowed = false;
                let after = 0;
                const reader = new CommandReader(SMALL, {
                    onLine: (line) => {
                        if (overflowed) after++;
                        segments.push(...line);
                    },
                    onContinue: () => {
                        if (overflowed) after++;
                    },
                    onOverflow: () => {
                        if (overflowed) after++;
                        overflowed = true;
                    }
                });
                reader.feed(bytes);
                reader.feed(Buffer.from('a9 NOOP\r\n'));
                assert.equal(after, 0);
                for (const segment of segments) {
                    if (typeof segment === 'string') assert.ok(segment.length <= SMALL.maxLine);
                    else assert.ok(segment.length <= SMALL.maxLiteral);
                }
            })
        );
    });
});

describe('parseCommand, sur des segments quelconques', () => {
    const segment = fc.oneof(
        fc.array(fc.oneof(word, argument, noise), { maxLength: 6 }).map((parts) => parts.join(' ')),
        fc.uint8Array({ maxLength: 16 }).map((bytes) => Buffer.from(bytes))
    );

    it('rend une commande ou lève ParseError, jamais autre chose', () => {
        fc.assert(
            fc.property(fc.array(segment, { maxLength: 30 }), (segments) => {
                try {
                    const command = parseCommand(segments);
                    assert.equal(typeof command.tag, 'string');
                    assert.equal(command.name, command.name.toUpperCase());
                } catch (error) {
                    assert.ok(error instanceof ParseError, `levé : ${String(error)}`);
                }
            })
        );
    });

    it('refuse des listes imbriquées sans fin au lieu d’épuiser la pile', () => {
        fc.assert(
            fc.property(fc.integer({ min: 18, max: 20_000 }), (depth) => {
                assert.throws(() => parseCommand([`a1 SEARCH ${'('.repeat(depth)}`]), ParseError);
            })
        );
    });
});

/** Le jeton que le lecteur doit rendre pour une valeur que le serveur écrit. */
function expected(value: ImapValue): Token {
    if (value === null) return { t: 'atom', v: 'NIL' };
    if (typeof value === 'number') return { t: 'atom', v: String(value) };
    if (typeof value === 'string') {
        const quoted = value.length <= 512 && /^[\x20-\x7e]*$/.test(value);
        return quoted ? { t: 'str', v: value } : { t: 'lit', v: Buffer.from(value, 'latin1') };
    }
    if (Array.isArray(value)) return { t: 'list', v: value.map(expected) };
    if ('atom' in value) return { t: 'atom', v: value.atom };
    if ('literal' in value) return { t: 'lit', v: value.literal };
    throw new Error('valeur hors du tirage');
}

const { value: imapValue } = fc.letrec<{ value: ImapValue }>((tie) => ({
    value: fc.oneof(
        { depthSize: 'small', maxDepth: 5 },
        fc.constant(null),
        fc.nat(),
        fc.string({ unit: 'binary-ascii', maxLength: 40 }),
        fc.uint8Array({ maxLength: 40 }).map((bytes) => Buffer.from(bytes).toString('latin1')),
        fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/).map(atom),
        fc.uint8Array({ maxLength: 40 }).map((bytes) => ({ literal: Buffer.from(bytes) })),
        fc.array(tie('value'), { maxLength: 4 })
    )
}));

describe('ce que le serveur écrit, relu par son propre lecteur', () => {
    it('redonne les mêmes valeurs : chaînes entre guillemets, littéraux, listes', () => {
        fc.assert(
            fc.property(fc.array(imapValue, { maxLength: 6 }), (values) => {
                const lines: Segment[][] = [];
                const reader = new CommandReader(WIDE, {
                    onLine: (segments) => lines.push(segments),
                    onContinue: () => undefined,
                    onOverflow: (reason) => assert.fail(`dépassement ${reason}`)
                });
                reader.feed(formatLine([atom('a1'), atom('NOOP'), ...values]));
                assert.equal(lines.length, 1);
                assert.deepEqual(parseCommand(lines[0]), { tag: 'a1', name: 'NOOP', args: values.map(expected) });
            })
        );
    });
});

describe('les allers-retours d’IMAP', () => {
    it('une date interne se relit à la seconde', () => {
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 253_402_300_799 }), (ts) => {
                assert.equal(parseImapDate(formatInternalDate(ts)), ts);
            })
        );
    });

    it('une date quelconque vaut null ou un nombre entier de secondes', () => {
        fc.assert(
            fc.property(
                fc.oneof(fc.string(), fc.stringMatching(/^\d{1,2}-[A-Za-z]{3}-\d{4}( \d{2}:\d{2}:\d{2} [+-]\d{4})?$/)),
                (text) => {
                    const ts = parseImapDate(text);
                    assert.ok(ts === null || Number.isInteger(ts));
                }
            )
        );
    });

    it('un nom de dossier fait l’aller-retour en UTF-7 modifié, et ne voyage qu’en ASCII imprimable', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary' }), (name) => {
                const encoded = encodeUtf7(name);
                assert.match(encoded, /^[\x20-\x7e]*$/);
                assert.equal(decodeUtf7(encoded), name);
            })
        );
    });

    it('décoder un nom quelconque ne lève jamais', () => {
        fc.assert(
            fc.property(
                fc.array(fc.oneof(fc.constantFrom('&', '-', ',', '&-', '&AOk-'), fc.string({ maxLength: 6 }))),
                (parts) => {
                    assert.equal(typeof decodeUtf7(parts.join('')), 'string');
                }
            )
        );
    });

    it('des UID rendus en plages se relisent comme le même ensemble', () => {
        fc.assert(
            fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 80 }), (picked) => {
                const uids = [...picked].sort((a, b) => a - b);
                const ranges = parseSequenceSet(compactUids(uids));
                assert.ok(ranges);
                const max = uids[uids.length - 1];
                for (let n = 1; n <= max + 2; n++) {
                    assert.equal(inSequenceSet(ranges, n, max), picked.includes(n), `uid ${n}`);
                }
            })
        );
    });

    it('un ensemble de séquences quelconque vaut null ou des plages de numéros positifs', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.string(),
                    fc.stringMatching(/^(\d{1,4}|\*)(:(\d{1,4}|\*))?(,(\d{1,4}|\*)(:(\d{1,4}|\*))?){0,6}$/)
                ),
                (text) => {
                    for (const range of parseSequenceSet(text) ?? []) {
                        for (const bound of [range.from, range.to]) assert.ok(bound === null || bound >= 1);
                    }
                }
            )
        );
    });
});

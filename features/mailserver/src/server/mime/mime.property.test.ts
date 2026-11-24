import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { CommandReader } from '../imap/parser';
import { formatLine, type ImapValue } from '../imap/wire';
import { buildBodyStructure } from './bodystructure';
import { buildEnvelope } from './envelope';
import { extractSection, parseSection, slicePartial } from './sections';
import { parseContentField, parseHeaders, parseMime, type MimeNode } from './tree';
import { decodeHeaderText } from './words';

/**
 * Un message arrive de n'importe qui, par le port 25 : son arbre se calcule
 * dans le processus du serveur, avant tout filtrage. Ces propriétés tirent des
 * messages imbriqués, puis les abîment.
 */

const bytes = (max: number): fc.Arbitrary<string> =>
    fc.uint8Array({ maxLength: max }).map((raw) => Buffer.from(raw).toString('latin1'));

const headerLine = fc.oneof(
    fc.constantFrom(
        'Content-Type: text/plain; charset=utf-8',
        'Content-Type: multipart/digest; boundary=b',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="a;b\\".txt"; size=3',
        'Content-Language: fr, en',
        'Content-ID: <1@x>',
        'Subject: =?UTF-8?Q?Caf=C3=A9?= =?iso-8859-1?B?6Q==?=',
        'From: "A, B" <a@example.org>, groupe: b@example.org, <c@example.org>;',
        'To: destinataires-masques:;',
        'Date: Tue, 24 Nov 2026 10:00:00 +0100',
        ' suite repliée',
        'sans deux-points',
        ': sans nom'
    ),
    fc
        .tuple(fc.stringMatching(/^[A-Za-z-]{1,12}$/), fc.string({ unit: 'binary-ascii', maxLength: 30 }))
        .map(([name, value]) => `${name}: ${value.replace(/[\r\n]/g, ' ')}`)
);

/** Peu de frontières, pour qu'un niveau tombe souvent sur celle d'un autre. */
const boundary = fc.constantFrom('b', 'bb', 'b b', '=_x', '--');

const bodyText = fc.oneof(
    fc.constantFrom('', '--b', '--b--', '--bb', 'ligne\n--b\nautre', '\r\n', '\n\n'),
    fc.string({ unit: 'binary-ascii', maxLength: 40 }),
    bytes(40)
);

function entityOf(nl: string): fc.Arbitrary<string> {
    return fc.letrec<{ entity: string }>((tie) => ({
        entity: fc.oneof(
            { maxDepth: 4, depthSize: 'small' },
            fc
                .tuple(fc.array(headerLine, { maxLength: 4 }), bodyText)
                .map(([headers, body]) => [...headers, '', body].join(nl)),
            // Une partie sans un octet, entre deux frontières qui se suivent.
            fc.constant(''),
            fc
                .tuple(
                    fc.array(headerLine, { maxLength: 2 }),
                    boundary,
                    fc.array(tie('entity'), { maxLength: 4 }),
                    fc.boolean(),
                    bodyText,
                    bodyText
                )
                .map(([headers, mark, parts, closed, preamble, epilogue]) =>
                    [
                        `Content-Type: multipart/mixed; boundary="${mark}"`,
                        ...headers,
                        '',
                        preamble,
                        ...parts.flatMap((part) => [`--${mark}`, part]),
                        ...(closed ? [`--${mark}--`] : []),
                        epilogue
                    ].join(nl)
                ),
            fc
                .tuple(fc.array(headerLine, { maxLength: 2 }), tie('entity'))
                .map(([headers, inner]) => ['Content-Type: message/rfc822', ...headers, '', inner].join(nl))
        )
    })).entity;
}

const noise = fc.oneof(
    fc.constantFrom(
        '--b',
        '--b--',
        '\r\n',
        '\n',
        '\r',
        '\r\n\r\n',
        ';',
        '"',
        '=',
        ':',
        'Content-Type: multipart/mixed; boundary=b\n\n'
    ),
    bytes(12)
);

/** Un message bien formé, puis des insertions et une coupure : ce que ferait un expéditeur hostile ou un relais fautif. */
const message = fc
    .constantFrom('\r\n', '\n')
    .chain(entityOf)
    .chain((text) =>
        fc.tuple(
            fc.constant(text),
            fc.array(fc.tuple(fc.nat(), noise), { maxLength: 3 }),
            fc.option(fc.nat(), { freq: 4 })
        )
    )
    .map(([text, insertions, cut]) => {
        let out = text;
        for (const [at, piece] of insertions) {
            const index = at % (out.length + 1);
            out = out.slice(0, index) + piece + out.slice(index);
        }
        if (cut !== null) out = out.slice(0, cut % (out.length + 1));
        return Buffer.from(out, 'latin1');
    });

interface Census {
    nodes: number;
    depth: number;
}

/** Chaque partie tient dans celle qui la contient, sans chevaucher sa voisine. */
function checkNode(node: MimeNode, from: number, to: number, depth: number, census: Census): void {
    census.nodes += 1;
    census.depth = Math.max(census.depth, depth);
    assert.ok(
        from <= node.start && node.start <= node.bodyStart && node.bodyStart <= node.end && node.end <= to,
        `partie [${node.start}, ${node.bodyStart}, ${node.end}] hors de [${from}, ${to}]`
    );
    assert.ok(Number.isInteger(node.lines) && node.lines >= 0 && node.lines <= node.end - node.bodyStart);
    if (node.children.length > 0) assert.equal(node.type, 'multipart');

    let cursor = node.bodyStart;
    for (const child of node.children) {
        checkNode(child, cursor, node.end, depth + 1, census);
        cursor = child.end;
    }
    if (node.message) {
        assert.equal(node.message.start, node.bodyStart);
        checkNode(node.message, node.bodyStart, node.end, depth + 1, census);
    }
}

function census(raw: Buffer): Census {
    const out: Census = { nodes: 0, depth: 0 };
    checkNode(parseMime(raw), 0, raw.length, 0, out);
    return out;
}

/** Les nombres d'une réponse sont des tailles et des comptes : jamais négatifs. */
function checkNumbers(value: ImapValue): void {
    if (typeof value === 'number') assert.ok(Number.isInteger(value) && value >= 0, `nombre ${value}`);
    else if (Array.isArray(value)) value.forEach(checkNumbers);
    else if (value !== null && typeof value === 'object' && 'glued' in value) value.glued.forEach(checkNumbers);
}

/** La réponse tient en une ligne pour qui la lit : chaque littéral annonce sa vraie taille. */
function assertOneLine(response: Buffer): void {
    let lines = 0;
    const reader = new CommandReader(
        { maxLine: response.length, maxLiteral: response.length },
        {
            onLine: () => (lines += 1),
            onContinue: () => undefined,
            onOverflow: (reason) => assert.fail(`dépassement ${reason}`)
        }
    );
    reader.feed(response);
    assert.equal(lines, 1);
}

const isViewOf = (raw: Buffer, part: Buffer): boolean =>
    part.buffer === raw.buffer &&
    part.byteOffset >= raw.byteOffset &&
    part.byteOffset + part.length <= raw.byteOffset + raw.length;

describe('parseMime, sur un message quelconque', () => {
    it('rend des parties emboîtées dans le message, en nombre et en profondeur bornés', () => {
        fc.assert(
            fc.property(message, (raw) => {
                const { nodes, depth } = census(raw);
                assert.ok(nodes <= 1_000);
                assert.ok(depth <= 20);
            })
        );
    });

    it('donne une structure et une enveloppe qui s’écrivent, sans taille négative', () => {
        fc.assert(
            fc.property(message, fc.boolean(), (raw, extended) => {
                const tree = parseMime(raw);
                const structure = buildBodyStructure(tree, extended);
                const envelope = buildEnvelope(tree.headers ?? []);
                checkNumbers(structure);
                assertOneLine(formatLine([structure, envelope]));
            })
        );
    });

    it('survit au passage par le JSON où il est gardé avec le message', () => {
        fc.assert(
            fc.property(message, (raw) => {
                const tree = parseMime(raw);
                assert.deepEqual(JSON.parse(JSON.stringify(tree)), tree);
            })
        );
    });
});

describe('parseMime, sur un message fabriqué pour coûter cher', () => {
    const HEAD = 'Content-Type: multipart/mixed; boundary=b\r\n\r\n';

    const timed = (text: string): { nodes: number; ms: number } => {
        const raw = Buffer.from(text, 'latin1');
        const started = performance.now();
        const { nodes } = census(raw);
        return { nodes, ms: performance.now() - started };
    };

    it('ne garde pas plus de mille parties d’un message qui en compte deux millions', () => {
        assert.equal(timed(HEAD + '--b\n'.repeat(2_000_000)).nodes, 1_000);
    });

    it('ne relit pas la fin du message pour chaque partie qui annonce une frontière absente', () => {
        const part = '--b\r\nContent-Type: multipart/mixed; boundary=zzzzzzzzzzzzzzzz\r\n\r\nx\r\n';
        const tail = `--b\r\n\r\n${'x'.repeat(24_000_000)}`;
        // Mesuré contre le même message sans ses parties : la machine et sa charge comptent des deux côtés.
        const one = timed(HEAD + tail);
        const many = timed(HEAD + part.repeat(998) + tail);
        assert.equal(many.nodes, 1_000);
        assert.ok(many.ms < 20 * one.ms + 500, `${Math.round(many.ms)} ms, contre ${Math.round(one.ms)} ms`);
    });

    it('s’arrête à vingt niveaux d’un message qui en emboîte dix mille', () => {
        const nested = Array.from(
            { length: 10_000 },
            (_, i) => `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n`
        );
        const wrapped = 'Content-Type: message/rfc822\r\n\r\n'.repeat(10_000);
        for (const text of [nested.join(''), wrapped]) {
            assert.equal(census(Buffer.from(text, 'latin1')).depth, 20);
        }
    });
});

describe('les sections d’un message quelconque', () => {
    const sectionText = fc.oneof(
        fc
            .tuple(
                fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 4 }),
                fc.constantFrom(
                    '',
                    'HEADER',
                    'TEXT',
                    'MIME',
                    'header',
                    'HEADER.FIELDS (subject from)',
                    'HEADER.FIELDS.NOT (content-type "x")',
                    'HEADER.FIELDS ()',
                    'AUTRE'
                )
            )
            .map(([path, part]) => [path.join('.'), part].filter((piece) => piece !== '').join('.')),
        fc.string({ maxLength: 24 })
    );

    it('une section est absente, ou une plage du message', () => {
        fc.assert(
            fc.property(message, sectionText, (raw, text) => {
                const spec = parseSection(text);
                if (spec === null) return;
                assert.ok(spec.path.every((index) => index >= 1));
                const data = extractSection(raw, parseMime(raw), spec);
                if (data === null) return;

                if (!spec.part.startsWith('HEADER.FIELDS')) {
                    assert.ok(isViewOf(raw, data));
                    return;
                }
                const kept = data.toString('latin1');
                assert.ok(kept.endsWith('\r\n'));
                for (const line of kept.slice(0, -2).split(/(?<=\n)/)) {
                    assert.ok(raw.includes(Buffer.from(line, 'latin1')), `ligne inventée : ${JSON.stringify(line)}`);
                }
            })
        );
    });

    it('les en-têtes et le texte d’un message le recomposent, et ceux d’une partie se suivent', () => {
        fc.assert(
            fc.property(message, fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 4 }), (raw, path) => {
                const tree = parseMime(raw);
                const header = extractSection(raw, tree, { path: [], part: 'HEADER', fields: [] });
                const text = extractSection(raw, tree, { path: [], part: 'TEXT', fields: [] });
                assert.ok(header && text);
                assert.deepEqual(Buffer.concat([header, text]), raw);

                if (path.length === 0) return;
                const mime = extractSection(raw, tree, { path, part: 'MIME', fields: [] });
                const body = extractSection(raw, tree, { path, part: '', fields: [] });
                assert.equal(mime === null, body === null);
                if (mime && body) assert.equal(mime.byteOffset + mime.length, body.byteOffset);
            })
        );
    });

    it('une tranche ne rend jamais plus que demandé, ni au-delà de la fin', () => {
        const size = fc.oneof(fc.nat(80), fc.constantFrom(Number.MAX_SAFE_INTEGER, 2 ** 64, Infinity));
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), size, size, (raw, start, length) => {
                const data = Buffer.from(raw);
                const slice = slicePartial(data, { start, length });
                assert.equal(slice.length, Math.max(0, Math.min(length, data.length - start)));
                assert.deepEqual(slice, data.subarray(Math.min(start, data.length)).subarray(0, slice.length));
            })
        );
    });
});

describe('les en-têtes d’un message quelconque', () => {
    const headerText = fc
        .array(
            fc.oneof(
                fc.constantFrom(
                    '=?',
                    '?=',
                    '?',
                    '=',
                    '*',
                    'UTF-8',
                    'x-inconnu',
                    '?B?',
                    '?q?',
                    ' ',
                    '\t',
                    '_',
                    '=C3',
                    '=A9'
                ),
                fc.constantFrom('<', '>', '(', ')', ':', ';', ',', '"', '\\', '@', 'a@b', 'g:'),
                fc.string({ unit: 'binary-ascii', maxLength: 8 }),
                bytes(8)
            ),
            { maxLength: 30 }
        )
        .map((parts) => parts.join(''));

    it('se lisent sans lever : blocs, champs à paramètres, mots encodés, adresses', () => {
        fc.assert(
            fc.property(headerText, (text) => {
                const field = parseContentField(text);
                assert.equal(field.value, field.value.toLowerCase());
                for (const [key, value] of Object.entries(field.params)) {
                    assert.equal(key, key.toLowerCase());
                    assert.equal(typeof value, 'string');
                }
                assert.equal(typeof decodeHeaderText(text), 'string');
                const headers = parseHeaders(`From: ${text}\r\nTo: ${text}\r\n${text}`);
                assertOneLine(formatLine(buildEnvelope(headers)));
            })
        );
    });

    it('un mot encodé rend le texte qu’on y a mis, en base64 comme en quoted-printable', () => {
        // Un BOM en tête est retiré par le décodeur : ce n'est pas du texte.
        const text = fc.string({ unit: 'grapheme', maxLength: 30 }).filter((value) => !value.startsWith('﻿'));
        fc.assert(
            fc.property(text, (value) => {
                const utf8 = Buffer.from(value, 'utf8');
                const quoted = [...utf8].map((byte) => `=${byte.toString(16).padStart(2, '0')}`).join('');
                assert.equal(decodeHeaderText(`=?UTF-8?B?${utf8.toString('base64')}?=`), value);
                assert.equal(decodeHeaderText(`=?utf-8?q?${quoted}?=`), value);
            })
        );
    });
});

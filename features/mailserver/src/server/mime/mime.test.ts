import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLine } from '../imap/wire';
import { buildBodyStructure } from './bodystructure';
import { buildEnvelope } from './envelope';
import { extractSection, parseSection, slicePartial } from './sections';
import { parseContentField, parseMime } from './tree';

const crlf = (text: string): Buffer => Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'latin1');
const wire = (value: Parameters<typeof formatLine>[0][number]): string =>
    formatLine([value]).toString('latin1').trimEnd();

const SIMPLE = crlf(`From: Alice <alice@exemple.fr>
To: bob@exemple.fr, "Carol, C." <carol@exemple.fr>
Subject: =?UTF-8?Q?Caf=C3=A9?=
Date: Mon, 7 Sep 2026 10:00:00 +0200
Message-ID: <1@exemple.fr>

Bonjour,
deux lignes.
`);

const MIXED = crlf(`From: a@x.fr
Subject: pieces
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

preambule ignore
--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain; charset=utf-8

texte
--inner
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<p>html</p>
--inner--
--outer
Content-Type: application/pdf; name="a b.pdf"
Content-Disposition: attachment; filename="a b.pdf"
Content-Transfer-Encoding: base64

QUJD
--outer--
epilogue
`);

const FORWARD = crlf(`From: a@x.fr
Content-Type: multipart/mixed; boundary=b

--b
Content-Type: text/plain

voir ci-joint
--b
Content-Type: message/rfc822

From: inner@y.fr
Subject: dedans
Content-Type: text/plain

corps interne
--b--
`);

test('un message simple : une partie texte, ses lignes et sa taille', () => {
    const tree = parseMime(SIMPLE);
    assert.equal(tree.type, 'text');
    assert.equal(tree.lines, 2);
    assert.equal(SIMPLE.subarray(tree.bodyStart, tree.end).toString(), 'Bonjour,\r\ndeux lignes.\r\n');
    assert.equal(wire(buildBodyStructure(tree, false)), '("text" "plain" NIL NIL NIL "7bit" 24 2)');
});

test('l’enveloppe garde les mots encodés, et Sender comme Reply-To retombent sur From', () => {
    const envelope = wire(buildEnvelope(parseMime(SIMPLE).headers ?? []));
    assert.equal(
        envelope,
        '("Mon, 7 Sep 2026 10:00:00 +0200" "=?UTF-8?Q?Caf=C3=A9?=" ' +
            '(("Alice" NIL "alice" "exemple.fr")) (("Alice" NIL "alice" "exemple.fr")) (("Alice" NIL "alice" "exemple.fr")) ' +
            '((NIL NIL "bob" "exemple.fr")("Carol, C." NIL "carol" "exemple.fr")) NIL NIL NIL "<1@exemple.fr>")'
    );
});

test('un multipart imbriqué : parties collées, sous-types, extensions', () => {
    const tree = parseMime(MIXED);
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[0].children.length, 2);
    assert.equal(
        wire(buildBodyStructure(tree, false)),
        '((("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 5 1)' +
            '("text" "html" ("charset" "utf-8") NIL NIL "quoted-printable" 11 1) "alternative")' +
            '("application" "pdf" ("name" "a b.pdf") NIL NIL "base64" 4) "mixed")'
    );
    const extended = wire(buildBodyStructure(tree, true));
    assert.ok(extended.includes('("attachment" ("filename" "a b.pdf"))'));
    assert.ok(extended.endsWith('"mixed" ("boundary" "outer") NIL NIL NIL)'));
});

test('les sections : chemin, HEADER, TEXT, MIME, sélection d’en-têtes, tranche', () => {
    const tree = parseMime(MIXED);
    const get = (section: string): string | null => {
        const spec = parseSection(section);
        assert.ok(spec, section);
        return extractSection(MIXED, tree, spec)?.toString('latin1') ?? null;
    };
    assert.equal(get('1.1'), 'texte');
    assert.equal(get('1.2'), '<p>html</p>');
    assert.equal(get('2'), 'QUJD');
    assert.equal(get('3'), null);
    assert.ok(get('2.MIME')?.startsWith('Content-Type: application/pdf'));
    assert.ok(get('HEADER')?.endsWith('boundary="outer"\r\n\r\n'));
    assert.ok(get('TEXT')?.startsWith('preambule ignore'));
    assert.equal(get('')?.length, MIXED.length);
    assert.equal(get('HEADER.FIELDS (subject x-absent)'), 'Subject: pieces\r\n\r\n');
    assert.equal(get('HEADER.FIELDS.NOT (from subject mime-version content-type)'), '\r\n');
    assert.equal(slicePartial(Buffer.from('abcdef'), { start: 2, length: 3 }).toString(), 'cde');
    assert.equal(slicePartial(Buffer.from('abcdef'), { start: 9, length: 3 }).length, 0);
    assert.equal(parseSection('MIME'), null);
    assert.equal(parseSection('0'), null);
});

test('un message enfermé : son enveloppe, sa structure, et ses propres sections', () => {
    const tree = parseMime(FORWARD);
    const inner = tree.children[1];
    assert.equal(inner.subtype, 'rfc822');
    assert.ok(inner.message);
    const structure = wire(buildBodyStructure(tree, false));
    assert.ok(structure.includes('"message" "rfc822"'));
    assert.ok(structure.includes('"dedans"'));
    const at = (section: string): string | null => {
        const spec = parseSection(section);
        assert.ok(spec);
        return extractSection(FORWARD, tree, spec)?.toString('latin1') ?? null;
    };
    assert.ok(at('2.HEADER')?.startsWith('From: inner@y.fr'));
    assert.equal(at('2.TEXT'), 'corps interne');
    assert.equal(at('2.1'), 'corps interne');
    assert.equal(at('1.HEADER'), null);
});

test('tolère les fins de ligne nues, la frontière de fin absente, et l’absence d’en-têtes', () => {
    const lf = Buffer.from('Subject: x\nContent-Type: multipart/mixed; boundary=z\n\n--z\n\nun\n--z\n\ndeux sans fin');
    const tree = parseMime(lf);
    assert.equal(tree.children.length, 2);
    assert.equal(lf.subarray(tree.children[0].bodyStart, tree.children[0].end).toString(), 'un');
    assert.equal(lf.subarray(tree.children[1].bodyStart, tree.children[1].end).toString(), 'deux sans fin');

    const bare = parseMime(Buffer.from('\r\njuste un corps'));
    assert.equal(bare.bodyStart, 2);
    assert.equal(parseMime(Buffer.from('Subject: seul')).lines, 0);
    assert.equal(parseMime(Buffer.alloc(0)).type, 'text');
});

test('une frontière qui n’est que le préfixe d’une autre ne coupe rien', () => {
    const raw = crlf(`Content-Type: multipart/mixed; boundary=ab

--ab
Content-Type: text/plain

--abc n'est pas une frontiere
--ab--
`);
    const tree = parseMime(raw);
    assert.equal(tree.children.length, 1);
    assert.ok(raw.subarray(tree.children[0].bodyStart, tree.children[0].end).toString().includes('--abc'));
});

test('parseContentField : guillemets, échappements, clés en double', () => {
    assert.deepEqual(parseContentField('Text/Plain; Charset="utf-8"; name="a;\\"b"; charset=autre'), {
        value: 'text/plain',
        params: { charset: 'utf-8', name: 'a;"b' }
    });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandReader, ParseError, parseCommand, stringOf, type Segment } from './parser';
import { compactUids, inSequenceSet, parseSequenceSet } from './sequence';
import { decodeUtf7, encodeUtf7 } from './utf7';
import { formatInternalDate, formatLine, parseImapDate } from './wire';

function reader(limits = { maxLine: 1024, maxLiteral: 64 }) {
    const lines: Segment[][] = [];
    const events: string[] = [];
    const r = new CommandReader(limits, {
        onLine: (segments) => lines.push(segments),
        onContinue: () => events.push('+'),
        onOverflow: (reason) => events.push(`overflow:${reason}`)
    });
    return { r, lines, events };
}

test('le lecteur recolle une commande coupée n’importe où, littéral compris', () => {
    const wire = Buffer.from('a1 LOGIN {5}\r\nalice {3+}\r\np w\r\na2 NOOP\r\n');
    for (let cut = 1; cut < wire.length; cut += 1) {
        const { r, lines, events } = reader();
        r.feed(wire.subarray(0, cut));
        r.feed(wire.subarray(cut));
        assert.equal(lines.length, 2, `coupe à ${cut}`);
        assert.deepEqual(lines[0], ['a1 LOGIN ', Buffer.from('alice'), ' ', Buffer.from('p w'), '']);
        // Un seul `+` : le second littéral est non synchronisant.
        assert.deepEqual(events, ['+']);
    }
});

test('le lecteur accepte les fins de ligne nues et les littéraux vides', () => {
    const { r, lines } = reader();
    r.feed(Buffer.from('a1 APPEND x {0+}\n\na2 NOOP\n'));
    assert.deepEqual(lines, [['a1 APPEND x ', Buffer.alloc(0), ''], ['a2 NOOP']]);
});

test('au-delà des bornes, le lecteur se tait pour de bon', () => {
    const long = reader({ maxLine: 8, maxLiteral: 64 });
    long.r.feed(Buffer.from('a1 NOOP tres long\r\na2 NOOP\r\n'));
    assert.deepEqual(long.events, ['overflow:line']);
    assert.equal(long.lines.length, 0);

    const big = reader();
    big.r.feed(Buffer.from('a1 APPEND x {65}\r\n'));
    assert.deepEqual(big.events, ['overflow:literal']);
});

test('parseCommand : atomes, guillemets, listes, littéraux, sections à crochets', () => {
    const fetch = parseCommand(['a1 UID FETCH 1:* (UID BODY.PEEK[HEADER.FIELDS (DATE FROM)]<0.100> FLAGS)']);
    assert.equal(fetch.name, 'UID');
    assert.deepEqual(fetch.args, [
        { t: 'atom', v: 'FETCH' },
        { t: 'atom', v: '1:*' },
        {
            t: 'list',
            v: [
                { t: 'atom', v: 'UID' },
                { t: 'atom', v: 'BODY.PEEK[HEADER.FIELDS (DATE FROM)]<0.100>' },
                { t: 'atom', v: 'FLAGS' }
            ]
        }
    ]);

    const login = parseCommand(['a2 login "a\\"b" ', Buffer.from('mot de passe'), '']);
    assert.equal(login.name, 'LOGIN');
    assert.deepEqual(login.args.map(stringOf), ['a"b', 'mot de passe']);

    assert.deepEqual(parseCommand(['a3 STORE 1 +FLAGS ()']).args[2], { t: 'list', v: [] });
    assert.deepEqual(parseCommand(['a4 NOOP']).args, []);
});

test('parseCommand refuse ce qui ne se lit pas', () => {
    for (const bad of ['', 'a1', 'a1 LIST "" "x', 'a1 FETCH 1 (UID', 'a1 X )', '* NOOP']) {
        assert.throws(() => parseCommand([bad]), ParseError, bad);
    }
});

test('les ensembles de séquences', () => {
    assert.equal(parseSequenceSet('1,,2'), null);
    assert.equal(parseSequenceSet('0'), null);
    assert.equal(parseSequenceSet('a'), null);
    const set = parseSequenceSet('1:3,7,10:*');
    assert.ok(set);
    assert.deepEqual(
        [1, 3, 4, 7, 9, 10, 12].map((n) => inSequenceSet(set, n, 12)),
        [true, true, false, true, false, true, true]
    );
    // `*` vaut le dernier numéro, même plus petit que le début de la plage.
    const open = parseSequenceSet('50:*');
    assert.ok(open);
    assert.equal(inSequenceSet(open, 12, 12), true);
    assert.equal(inSequenceSet(open, 11, 12), false);
    assert.equal(compactUids([1, 2, 3, 7, 9, 10]), '1:3,7,9:10');
    assert.equal(compactUids([]), '');
});

test('l’UTF-7 modifié des noms de dossiers', () => {
    for (const [plain, encoded] of [
        ['INBOX', 'INBOX'],
        ['Envoyés', 'Envoy&AOk-s'],
        ['A & B', 'A &- B'],
        ['日本語', '&ZeVnLIqe-'],
        ['Reçus/été 😀', 'Re&AOc-us/&AOk-t&AOk- &2D3eAA-']
    ] as const) {
        assert.equal(encodeUtf7(plain), encoded);
        assert.equal(decodeUtf7(encoded), plain);
    }
});

test('le fil : guillemets quand c’est possible, littéral sinon, dates internes', () => {
    assert.equal(
        formatLine(['simple', 'a"b\\c', null, 42, [{ atom: '\\Seen' }]]).toString(),
        '"simple" "a\\"b\\\\c" NIL 42 (\\Seen)\r\n'
    );
    assert.equal(formatLine(['deux\r\nlignes']).toString('latin1'), '{12}\r\ndeux\r\nlignes\r\n');
    assert.equal(formatLine([{ literal: Buffer.from([0xe9]) }]).toString('latin1'), '{1}\r\n\xe9\r\n');
    assert.equal(formatInternalDate(837_571_465), '17-Jul-1996 02:44:25 +0000');
    assert.equal(parseImapDate('17-Jul-1996 02:44:25 -0700'), 837_596_665);
    assert.equal(parseImapDate('1-jan-2026'), Date.UTC(2026, 0, 1) / 1000);
    assert.equal(parseImapDate('hier'), null);
});

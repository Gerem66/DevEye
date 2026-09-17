import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import tls from 'node:tls';

import { createTestEngine, sampleMessage, selfSigned, testTlsStore } from '../testing/harness';
import { createImapServer, type ImapServer } from './server';

/**
 * Le protocole à la main, pour ce que les clients de bureau envoient et
 * qu'imapflow n'envoie pas : LOGIN, littéraux synchronisants, commandes par
 * numéro de séquence, sections partielles, hiérarchie de dossiers.
 */

const engine = createTestEngine();
let server: ImapServer;
let port = 0;

class Wire {
    private buffer = '';
    private waiters: (() => void)[] = [];
    private tag = 0;

    private constructor(private readonly socket: tls.TLSSocket) {
        socket.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString('latin1');
            for (const wake of this.waiters.splice(0)) wake();
        });
    }

    static async open(): Promise<Wire> {
        const socket = tls.connect({ host: 'localhost', port, ca: selfSigned().cert });
        await new Promise<void>((resolve, reject) => {
            socket.once('secureConnect', resolve);
            socket.once('error', reject);
        });
        const wire = new Wire(socket);
        await wire.until(/^\* OK .*\r\n/m);
        return wire;
    }

    /** Attend que le tampon contienne le motif, et rend tout ce qui le précède, lui compris. */
    async until(pattern: RegExp): Promise<string> {
        for (;;) {
            const m = pattern.exec(this.buffer);
            if (m) {
                const end = m.index + m[0].length;
                const out = this.buffer.slice(0, end);
                this.buffer = this.buffer.slice(end);
                return out;
            }
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
    }

    raw(text: string): void {
        this.socket.write(text);
    }

    /** Envoie une commande et rend sa réponse entière, ligne étiquetée comprise. */
    async cmd(text: string): Promise<string> {
        this.tag += 1;
        const tag = `t${this.tag}`;
        this.raw(`${tag} ${text}\r\n`);
        return this.until(new RegExp(`^${tag} (OK|NO|BAD)[^\\r]*\\r\\n`, 'm'));
    }

    close(): void {
        this.socket.destroy();
    }
}

before(async () => {
    const mailbox = await engine.createMailbox('carol@exemple.test', 'secret-de-carol');
    const inbox = await engine.repo.findFolder(mailbox.id, 'INBOX');
    assert.ok(inbox);
    for (const subject of ['Un', 'Deux', 'Trois']) {
        await engine.store.append(mailbox, inbox, sampleMessage(subject, `Corps de ${subject}.`), {
            internalDate: 1_788_000_000
        });
    }
    server = createImapServer(
        {
            repo: engine.repo,
            store: engine.store,
            auth: engine.auth,
            notifier: engine.notifier,
            hostname: 'localhost',
            maxMessageBytes: 4_096,
            logger: engine.deps.logger
        },
        testTlsStore()
    );
    port = await server.listen(0);
});

after(async () => {
    await server.stop();
    engine.events.stop();
});

describe('le protocole à la main', () => {
    it('rien avant LOGIN, qui accepte un mot de passe en littéral synchronisant', async () => {
        const wire = await Wire.open();
        assert.match(await wire.cmd('SELECT INBOX'), /BAD Log in first/);
        assert.match(await wire.cmd('LOGIN carol@exemple.test "faux"'), /NO \[AUTHENTICATIONFAILED\]/);

        wire.raw('x1 LOGIN carol@exemple.test {15}\r\n');
        await wire.until(/^\+ OK\r\n/m);
        wire.raw('secret-de-carol\r\n');
        assert.match(await wire.until(/^x1 (OK|NO|BAD)[^\r]*\r\n/m), /x1 OK \[CAPABILITY/);
        wire.close();
    });

    it('AUTHENTICATE PLAIN, en deux temps puis d’un seul', async () => {
        const token = Buffer.from('\0carol@exemple.test\0secret-de-carol').toString('base64');
        const twoSteps = await Wire.open();
        twoSteps.raw('a1 AUTHENTICATE PLAIN\r\n');
        await twoSteps.until(/^\+ \r\n/m);
        twoSteps.raw(`${token}\r\n`);
        assert.match(await twoSteps.until(/^a1 [A-Z]+[^\r]*\r\n/m), /a1 OK/);
        twoSteps.close();

        const oneStep = await Wire.open();
        assert.match(await oneStep.cmd(`AUTHENTICATE PLAIN ${token}`), /OK/);
        oneStep.close();
    });

    it('la hiérarchie : CREATE crée les parents, LIST filtre par motif, RENAME emporte les enfants', async () => {
        const wire = await Wire.open();
        await wire.cmd('LOGIN carol@exemple.test secret-de-carol');
        assert.match(await wire.cmd('LIST "" ""'), /\* LIST \(\\Noselect\) "\/" ""/);
        assert.match(await wire.cmd('CREATE "Clients/Dupont/2026"'), /OK/);
        assert.match(await wire.cmd('CREATE "Clients/Dupont/2026"'), /NO \[ALREADYEXISTS\]/);
        assert.match(await wire.cmd('CREATE "Re&AOc-us"'), /OK/);

        const top = await wire.cmd('LIST "" "%"');
        assert.match(top, /\* LIST \(\\HasChildren\) "\/" "Clients"/);
        assert.match(top, /\* LIST \(\\HasNoChildren \\Sent\) "\/" "Sent"/);
        assert.match(top, /"Re&AOc-us"/);
        assert.doesNotMatch(top, /Dupont/);
        assert.match(await wire.cmd('LIST "Clients" "*"'), /"Clients\/Dupont\/2026"/);
        assert.match(await wire.cmd('list "" inbox'), /\* LIST \(\\HasNoChildren\) "\/" "INBOX"/);

        assert.match(await wire.cmd('DELETE Clients'), /NO \[HASCHILDREN\]/);
        assert.match(await wire.cmd('RENAME Clients Comptes'), /OK/);
        assert.match(await wire.cmd('LIST "" "Comptes/*"'), /"Comptes\/Dupont\/2026"/);
        assert.match(await wire.cmd('UNSUBSCRIBE "Comptes/Dupont"'), /OK/);
        const subscribed = await wire.cmd('LSUB "" "*"');
        assert.doesNotMatch(subscribed, /"Comptes\/Dupont"\r/);
        assert.match(subscribed, /"Comptes\/Dupont\/2026"/);
        assert.match(await wire.cmd('DELETE INBOX'), /NO \[CANNOT\]/);
        assert.match(
            await wire.cmd('STATUS INBOX (MESSAGES UNSEEN UIDNEXT RECENT)'),
            /\* STATUS "INBOX" \(MESSAGES 3 UNSEEN 3 UIDNEXT 4 RECENT 0\)/
        );
        wire.close();
    });

    it('par numéro de séquence : en-têtes choisis, tranche, macro, STORE, COPY, EXPUNGE', async () => {
        const wire = await Wire.open();
        await wire.cmd('LOGIN carol@exemple.test secret-de-carol');
        const selected = await wire.cmd('SELECT INBOX');
        assert.match(selected, /\* 3 EXISTS/);
        assert.match(selected, /\[UNSEEN 1\]/);
        assert.match(selected, /OK \[READ-WRITE\]/);

        const headers = await wire.cmd('FETCH 2 (BODY.PEEK[HEADER.FIELDS (Subject X-Absent)])');
        assert.match(
            headers,
            /\* 2 FETCH \(BODY\[HEADER\.FIELDS \(Subject X-Absent\)\] \{17\}\r\nSubject: Deux\r\n\r\n\)/
        );

        const partial = await wire.cmd('FETCH 1 (BODY.PEEK[TEXT]<0.5>)');
        assert.match(partial, /BODY\[TEXT\]<0> \{5\}\r\nCorps\)/);
        assert.match(await wire.cmd('FETCH 1 BODY.PEEK[1]<900.5>'), /BODY\[1\]<900> \{0\}\r\n\)/);

        const fast = await wire.cmd('FETCH 1:* FAST');
        assert.equal((fast.match(/RFC822\.SIZE \d+/g) ?? []).length, 3);
        assert.match(fast, /INTERNALDATE "\d{2}-[A-Z][a-z]{2}-\d{4} /);

        // Sans PEEK, lire le texte marque le message lu, et la réponse le dit.
        assert.match(await wire.cmd('FETCH 3 RFC822.TEXT'), /\* 3 FETCH \(FLAGS \(\\Seen\) RFC822\.TEXT/);

        assert.match(
            await wire.cmd('STORE 1:2 +FLAGS (\\Deleted $Traite)'),
            /\* 2 FETCH \(FLAGS \(\\Deleted \$Traite\)\)/
        );
        assert.doesNotMatch(await wire.cmd('STORE 2 -FLAGS.SILENT \\Deleted'), /\* 2 FETCH/);
        assert.match(await wire.cmd('SEARCH DELETED'), /\* SEARCH 1\r\n/);
        assert.match(await wire.cmd('SEARCH NOT DELETED KEYWORD $Traite'), /\* SEARCH 2\r\n/);
        assert.match(await wire.cmd('SEARCH OR SUBJECT trois (SEEN SMALLER 10)'), /\* SEARCH 3\r\n/);
        assert.match(await wire.cmd('SEARCH SINCE 1-Jan-2026 2:3'), /\* SEARCH 2 3\r\n/);
        assert.match(await wire.cmd('SEARCH CHARSET KOI8-R ALL'), /NO \[BADCHARSET/);

        assert.match(await wire.cmd('COPY 3 Archive'), /OK \[COPYUID \d+ 3 1\]/);
        assert.match(await wire.cmd('COPY 3 Nulle-Part'), /NO \[TRYCREATE\]/);
        const expunged = await wire.cmd('EXPUNGE');
        assert.match(expunged, /\* 1 EXPUNGE/);
        assert.equal((expunged.match(/EXPUNGE\r\n/g) ?? []).length, 1);
        // Les numéros ont glissé : l'ancien 2 est devenu le 1.
        assert.match(await wire.cmd('FETCH 1 (UID)'), /\* 1 FETCH \(UID 2\)/);
        wire.close();
    });

    it('EXAMINE lit sans rien changer, CLOSE expurge en silence', async () => {
        const wire = await Wire.open();
        await wire.cmd('LOGIN carol@exemple.test secret-de-carol');
        assert.match(await wire.cmd('EXAMINE Archive'), /OK \[READ-ONLY\]/);
        assert.match(await wire.cmd('STORE 1 +FLAGS (\\Deleted)'), /NO Mailbox is read-only/);
        assert.doesNotMatch(await wire.cmd('FETCH 1 RFC822.TEXT'), /\\Seen/);

        await wire.cmd('SELECT Archive');
        await wire.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
        assert.doesNotMatch(await wire.cmd('CLOSE'), /EXPUNGE/);
        assert.match(await wire.cmd('STATUS Archive (MESSAGES)'), /MESSAGES 0/);
        assert.match(await wire.cmd('FETCH 1 UID'), /BAD Select a mailbox first/);
        wire.close();
    });

    it('APPEND par littéral, avec drapeaux et date, et refuse au-delà de la taille annoncée', async () => {
        const wire = await Wire.open();
        await wire.cmd('LOGIN carol@exemple.test secret-de-carol');
        const message = sampleMessage('Envoyé').toString('latin1');
        wire.raw(`p1 APPEND Sent (\\Seen) "07-Sep-2026 10:00:00 +0200" {${message.length}+}\r\n${message}\r\n`);
        assert.match(await wire.until(/^p1 [A-Z]+[^\r]*\r\n/m), /p1 OK \[APPENDUID \d+ 1\]/);
        await wire.cmd('SELECT Sent');
        assert.match(
            await wire.cmd('FETCH 1 (FLAGS INTERNALDATE)'),
            /FLAGS \(\\Seen\) INTERNALDATE "07-Sep-2026 08:00:00 \+0000"/
        );

        wire.raw('p2 APPEND Sent {99999}\r\n');
        assert.match(await wire.until(/^\* BYE[^\r]*\r\n/m), /TOOBIG/);
        wire.close();
    });

    it('un inconnu ne fait pas allouer au serveur le littéral d’un APPEND', async () => {
        const wire = await Wire.open();
        wire.raw('z1 LOGIN carol@exemple.test {1000000}\r\n');
        assert.match(await wire.until(/^\* BYE[^\r]*\r\n/m), /TOOBIG/);
        wire.close();
    });

    it('des commandes illisibles ne font pas tomber la session', async () => {
        const wire = await Wire.open();
        assert.match(await wire.cmd('LOGIN "pas ferme'), /BAD/);
        wire.raw('\r\n');
        assert.match(await wire.until(/^\* BAD[^\r]*\r\n/m), /BAD/);
        assert.match(await wire.cmd('NOOP'), /OK/);
        assert.match(await wire.cmd('XYZZY'), /BAD/);
        assert.match(await wire.cmd('LOGOUT'), /\* BYE[\s\S]*OK LOGOUT/);
        wire.close();
    });
});

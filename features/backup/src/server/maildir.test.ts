import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import type { MailBackupMessage, MailServerBackupProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { encodeMailboxName, keywordTable, maildirFileName, maildirFolder } from './maildir';
import { mailboxSource } from './sources';

/**
 * Une archive de boîte doit se déposer telle quelle dans le dossier mail d'un
 * Dovecot : noms de dossier en UTF-7 modifié, drapeaux dans les noms de
 * fichier, mots-clés dans `dovecot-keywords`.
 */

const exec = promisify(execFile);

async function hasTar(): Promise<boolean> {
    try {
        await exec('tar', ['--version']);
        return true;
    } catch {
        return false;
    }
}

const message = (over: Partial<MailBackupMessage> & Pick<MailBackupMessage, 'id' | 'uid'>): MailBackupMessage => ({
    size: 0,
    internalDate: 1_788_000_000,
    flags: [],
    keywords: [],
    ...over
});

describe('Maildir', () => {
    it('écrit les noms de dossier en UTF-7 modifié, comme Dovecot', () => {
        assert.equal(encodeMailboxName('Envoyés'), 'Envoy&AOk-s');
        assert.equal(encodeMailboxName('A&B'), 'A&-B');
        assert.equal(encodeMailboxName('台北'), '&U,BTFw-');
        assert.equal(encodeMailboxName('日本語'), '&ZeVnLIqe-');
    });

    it('range INBOX à la racine, les autres en `.A.B`, et un point devient `_`', () => {
        assert.deepEqual(maildirFolder('INBOX'), { dir: '', name: 'INBOX', renamed: false });
        assert.deepEqual(maildirFolder('Projets/2026'), { dir: '.Projets.2026', name: 'Projets.2026', renamed: false });
        assert.deepEqual(maildirFolder('v1.2'), { dir: '.v1_2', name: 'v1_2', renamed: true });
    });

    it('nomme un message de ses drapeaux puis de ses mots-clés, dans l’ordre ASCII', () => {
        const table = keywordTable(['$Forwarded', 'Projet']);
        assert.equal(table.file, '0 $Forwarded\n1 Projet\n');
        const name = maildirFileName(
            message({ id: 12, uid: 3, size: 40, flags: ['seen', 'flagged'], keywords: ['Projet'] }),
            table.letters
        );
        assert.equal(name, '1788000000.M12.deveye,S=40:2,FSb');
    });

    it('ne garde que 26 mots-clés par dossier, et compte les autres', () => {
        const keywords = Array.from({ length: 28 }, (_, i) => `k${i}`);
        const table = keywordTable(keywords);
        assert.equal(table.letters.get('k25'), 'z');
        assert.equal(table.letters.has('k26'), false);
        assert.equal(table.dropped, 2);
    });

    it('une boîte s’extrait en Maildir, et ce qui manque est dit', async (t) => {
        if (!(await hasTar())) {
            t.skip('tar absent');
            return;
        }
        const bodies = new Map<number, Buffer>([
            [1, Buffer.from('Subject: un\r\n\r\nUn.\r\n')],
            [3, Buffer.from('Subject: trois\r\n\r\nTrois.\r\n')]
        ]);
        const provider: MailServerBackupProvider = {
            listMailboxes: async () => [],
            findMailbox: async () => null,
            folders: async () => [
                { id: 10, path: 'INBOX', specialUse: null, subscribed: true, keywords: ['$Forwarded'] },
                { id: 11, path: 'Envoyés', specialUse: '\\Sent', subscribed: true, keywords: [] },
                { id: 12, path: 'v1.2', specialUse: null, subscribed: false, keywords: [] }
            ],
            messages: async (_mailbox, folderId, afterUid) => {
                if (afterUid > 0) return [];
                if (folderId === 10) {
                    return [
                        message({
                            id: 1,
                            uid: 1,
                            size: bodies.get(1)?.length ?? 0,
                            flags: ['seen'],
                            keywords: ['$Forwarded']
                        }),
                        message({ id: 2, uid: 2, size: 10 })
                    ];
                }
                if (folderId === 12) return [message({ id: 3, uid: 1, size: bodies.get(3)?.length ?? 0 })];
                return [];
            },
            async open(_mailbox, messageId) {
                const body = bodies.get(messageId);
                if (!body) return null;
                return (async function* () {
                    yield body;
                })();
            },
            authorize: async () => ({ ok: true })
        };

        const artifact = await mailboxSource(
            provider,
            { id: 9, address: 'contact@exemple.fr' },
            createTestServiceDeps().logger
        );
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-maildir-'));
        try {
            const parts: Buffer[] = [];
            for await (const chunk of artifact.stream) parts.push(chunk);
            await fs.writeFile(path.join(dir, 'boite.tar.gz'), Buffer.concat(parts));
            await exec('tar', ['-xzf', 'boite.tar.gz'], { cwd: dir });

            const root = path.join(dir, 'contact@exemple.fr');
            assert.equal(await fs.readFile(path.join(root, 'subscriptions'), 'utf8'), 'INBOX\nEnvoy&AOk-s\n');
            assert.equal(await fs.readFile(path.join(root, 'dovecot-keywords'), 'utf8'), '0 $Forwarded\n');
            const inbox = await fs.readdir(path.join(root, 'cur'));
            assert.deepEqual(inbox, [`1788000000.M1.deveye,S=${bodies.get(1)?.length}:2,Sa`]);
            assert.equal(await fs.readFile(path.join(root, 'cur', inbox[0]), 'utf8'), bodies.get(1)?.toString());

            await fs.access(path.join(root, '.Envoy&AOk-s', 'maildirfolder'));
            assert.deepEqual(await fs.readdir(path.join(root, '.Envoy&AOk-s', 'new')), []);
            assert.equal((await fs.readdir(path.join(root, '.v1_2', 'cur'))).length, 1);

            assert.equal(
                artifact.warning?.(),
                '1 message effacé pendant la sauvegarde, 1 dossier dont le point est devenu « _ ».'
            );
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import tls from 'node:tls';

import { selfSigned } from '../testing/harness';
import { certificateFlaws, TLS_POLICY, TlsStore } from './tls';

const now = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let signedCache: { leaf: string; fullchain: string; key: string } | null = null;

/** Un certificat de `mail.exemple.test` signé par une autorité de test, avec et sans sa chaîne. */
function caSigned(): { leaf: string; fullchain: string; key: string } {
    if (signedCache) return signedCache;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailserver-ca-'));
    const at = (name: string): string => path.join(dir, name);
    const openssl = (...args: string[]): void => {
        execFileSync('openssl', args, { stdio: 'ignore' });
    };
    try {
        openssl(
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '2',
            '-keyout',
            at('ca.key'),
            '-out',
            at('ca.pem'),
            '-subj',
            '/CN=Autorite de test'
        );
        openssl(
            'req',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            at('leaf.key'),
            '-out',
            at('leaf.csr'),
            '-subj',
            '/CN=mail.exemple.test'
        );
        fs.writeFileSync(at('ext.cnf'), 'subjectAltName=DNS:mail.exemple.test\n');
        openssl(
            'x509',
            '-req',
            '-in',
            at('leaf.csr'),
            '-CA',
            at('ca.pem'),
            '-CAkey',
            at('ca.key'),
            '-CAcreateserial',
            '-days',
            '2',
            '-extfile',
            at('ext.cnf'),
            '-out',
            at('leaf.pem')
        );
        const leaf = fs.readFileSync(at('leaf.pem'), 'utf8');
        signedCache = {
            leaf,
            fullchain: leaf + fs.readFileSync(at('ca.pem'), 'utf8'),
            key: fs.readFileSync(at('leaf.key'), 'utf8')
        };
        return signedCache;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('certificateFlaws', () => {
    it('ne dit rien d’un certificat valable pour le nom du serveur', () => {
        assert.deepEqual(certificateFlaws(selfSigned().cert, 'localhost', now), []);
    });

    it('dit l’expiration, le nom non couvert, la date d’entrée en vigueur', () => {
        const { cert } = selfSigned();
        assert.match(certificateFlaws(cert, 'localhost', now + 3 * DAY).join(), /^expiré depuis le /);
        assert.match(certificateFlaws(cert, 'localhost', now - DAY).join(), /^valide seulement à partir du /);
        assert.deepEqual(certificateFlaws(cert, 'mail.exemple.test', now), ['ne couvre pas mail.exemple.test']);
    });

    it('réclame la chaîne d’un certificat signé par une autorité', () => {
        const signed = caSigned();
        assert.deepEqual(certificateFlaws(signed.leaf, 'mail.exemple.test', now), [
            'chaîne incomplète (fournir fullchain.pem)'
        ]);
        assert.deepEqual(certificateFlaws(signed.fullchain, 'mail.exemple.test', now), []);
    });
});

describe('TlsStore', () => {
    it('ne remplace jamais un bon certificat par un défectueux', () => {
        const store = new TlsStore('localhost');
        const good = selfSigned();
        store.set(good, 'file');
        const signed = caSigned();
        assert.throws(() => store.set({ cert: signed.fullchain, key: signed.key }, 'file'), /ne couvre pas localhost/);
        assert.equal(store.current(), good);
    });

    it('sert un certificat défectueux faute de mieux, et le dit', () => {
        const store = new TlsStore('mail.exemple.test');
        const pem = selfSigned();
        store.set(pem, 'file');
        assert.equal(store.current(), pem);
        assert.equal(store.lastError, 'Certificat servi faute de mieux : ne couvre pas mail.exemple.test');

        const signed = caSigned();
        store.set({ cert: signed.fullchain, key: signed.key }, 'file');
        assert.equal(store.lastError, '');
    });

    it('refuse une clé qui ne va pas avec le certificat', () => {
        const store = new TlsStore('localhost');
        assert.throws(() => store.set({ cert: selfSigned().cert, key: caSigned().key }, 'file'));
        assert.equal(store.current(), null);
    });
});

describe('TLS_POLICY', () => {
    let server: tls.Server;
    let port = 0;

    before(async () => {
        server = tls.createServer({ ...selfSigned(), ...TLS_POLICY }, (socket) => socket.end());
        server.on('tlsClientError', () => undefined);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    /** La suite négociée par un client réglé ainsi, ou `null` s'il n'y a pas d'accord. */
    const negotiate = (options: tls.ConnectionOptions): Promise<{ protocol: string; cipher: string } | null> =>
        new Promise((resolve) => {
            const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...options }, () => {
                resolve({ protocol: socket.getProtocol() ?? '', cipher: socket.getCipher().standardName });
                socket.destroy();
            });
            socket.on('error', () => resolve(null));
        });

    it('passe en TLS 1.3 avec un client à jour', async () => {
        assert.equal((await negotiate({}))?.protocol, 'TLSv1.3');
    });

    it('impose son ordre en TLS 1.2 : le chiffrement authentifié avant le CBC', async () => {
        const chosen = await negotiate({
            maxVersion: 'TLSv1.2',
            ciphers: 'ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-GCM-SHA384'
        });
        assert.equal(chosen?.cipher, 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384');
    });

    it('refuse un échange de clés non éphémère et une signature en SHA-224', async () => {
        assert.equal(await negotiate({ maxVersion: 'TLSv1.2', ciphers: 'AES128-GCM-SHA256' }), null);
        assert.equal(await negotiate({ maxVersion: 'TLSv1.2', sigalgs: 'RSA+SHA224' }), null);
    });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { selfSigned } from '../testing/harness';
import { memoryRepo } from '../testing/memoryRepo';

/** Un port libre à cet instant : ouvert sur 0, relevé, refermé. */
function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const probe = net.createServer().listen(0, () => {
            const address = probe.address();
            probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
        });
    });
}

/** Vrai si quelque chose accepte une connexion sur ce port. */
function listening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: 'localhost', port }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

test('le moteur ouvre ses quatre ports sur un certificat fourni, s’arrête sans attendre un client muet, et redémarre', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailserver-engine-'));
    const pem = selfSigned();
    fs.writeFileSync(path.join(dir, 'cert.pem'), pem.cert);
    fs.writeFileSync(path.join(dir, 'key.pem'), pem.key);
    const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    // L'environnement se lit à l'import du module : il se pose avant.
    Object.assign(process.env, {
        MAILSERVER_HOSTNAME: 'localhost',
        MAILSERVER_STORAGE_DIR: path.join(dir, 'data'),
        MAILSERVER_TLS_CERT_FILE: path.join(dir, 'cert.pem'),
        MAILSERVER_TLS_KEY_FILE: path.join(dir, 'key.pem'),
        MAILSERVER_PORT_SMTP: String(ports[0]),
        MAILSERVER_PORT_SUBMISSIONS: String(ports[1]),
        MAILSERVER_PORT_SUBMISSION: String(ports[2]),
        MAILSERVER_PORT_IMAPS: String(ports[3])
    });
    const { createEngine } = await import('./engine');
    const engine = createEngine(createTestServiceDeps({ repo: memoryRepo() }));
    try {
        await engine.start();
        const status = await engine.handle.status();
        assert.equal(status.configured, true);
        assert.deepEqual(
            status.listeners.map((l) => [l.name, l.up, l.reason]),
            [
                ['smtp', true, ''],
                ['submissions', true, ''],
                ['submission', true, ''],
                ['imaps', true, '']
            ]
        );
        assert.equal(status.certificate?.source, 'file');
        assert.deepEqual(engine.handle.connection(), {
            host: 'localhost',
            imapPort: 993,
            smtpPort: 465,
            submissionPort: 587
        });

        // Un client connecté qui ne dit rien et ne ferme jamais.
        const idle = tls.connect({ host: 'localhost', port: ports[3], ca: pem.cert });
        await new Promise<void>((resolve, reject) => {
            idle.once('secureConnect', resolve);
            idle.once('error', reject);
        });
        idle.on('error', () => undefined);

        const started = Date.now();
        await engine.stop();
        assert.ok(Date.now() - started < 1_500, `arrêt en ${Date.now() - started} ms`);
        idle.destroy();
        assert.deepEqual(await Promise.all(ports.map(listening)), [false, false, false, false]);
        assert.ok((await engine.handle.status()).listeners.every((l) => !l.up));

        // Le même objet redémarré rouvre ses quatre ports, certificat déjà en main.
        await engine.start();
        assert.deepEqual(await Promise.all(ports.map(listening)), [true, true, true, true]);
        assert.ok((await engine.handle.status()).listeners.every((l) => l.up));
    } finally {
        await engine.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

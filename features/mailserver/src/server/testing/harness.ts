import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SdkDomain } from '@deveye/types/sdk/server';
import { createTestServiceDeps, testDomain } from '@deveye/types/sdk/testing';

import { createAuthenticator } from '../engine/auth';
import { memoryBlobStore } from '../engine/blobs';
import { createDelivery } from '../engine/delivery';
import { createEventRecorder } from '../engine/events';
import { createMailStore } from '../engine/mailstore';
import { Notifier } from '../engine/notifier';
import { TlsStore } from '../engine/tls';
import { createInitialFolders } from '../folders';
import { hashSecret } from '../passwords';
import type { MailboxRow } from '../repo';
import { memoryRepo } from './memoryRepo';

/**
 * Le moteur monté en mémoire : dépôt, corps, notifieur, authentification, sans
 * un seul port ouvert. `paused` : les boîtes que l'offre tient en pause, qu'un
 * test remplit à la volée.
 */
export function createTestEngine(domains: readonly SdkDomain[] = [testDomain({ id: 1, host: 'exemple.test' })]) {
    const repo = memoryRepo();
    const blobs = memoryBlobStore();
    const paused: string[] = [];
    const deps = createTestServiceDeps({ repo, domains, pausedItems: { addresses: paused } });
    const notifier = new Notifier();
    const beats: number[] = [];
    const events = createEventRecorder({ repo, cipherFor: deps.cipherFor, beat: (ws) => beats.push(ws) });
    const store = createMailStore({ repo, blobs, keys: deps.keys, cipherFor: deps.cipherFor, notifier });
    const auth = createAuthenticator({ repo, events, pauses: deps.pauses });
    const delivery = createDelivery({ repo, domains: deps.domains, pauses: deps.pauses, store, events });

    async function createMailbox(
        address: string,
        password: string,
        quotaBytes = 50 * 1024 * 1024
    ): Promise<MailboxRow> {
        const [localPart] = address.split('@');
        const id = await repo.createMailbox({
            workspaceId: 1,
            domainId: 1,
            localPart,
            address,
            passwordHash: await hashSecret(password),
            quotaBytes,
            outboundDailyLimit: 200,
            blobKey: deps.keys.sealBytes(crypto.randomBytes(32)),
            content: JSON.stringify({ displayName: '' }),
            now: 1_700_000_000
        });
        await createInitialFolders(repo, id);
        const row = await repo.findById(id);
        if (!row) throw new Error('boîte de test illisible');
        return row;
    }

    return { repo, blobs, deps, paused, notifier, events, store, auth, delivery, beats, createMailbox };
}

let cached: { cert: string; key: string } | null = null;

/** Un certificat auto-signé pour `localhost`, fait une fois par processus de test. */
export function selfSigned(): { cert: string; key: string } {
    if (cached) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailserver-tls-'));
    try {
        const keyFile = path.join(dir, 'key.pem');
        const certFile = path.join(dir, 'cert.pem');
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-days',
                '2',
                '-keyout',
                keyFile,
                '-out',
                certFile,
                '-subj',
                '/CN=localhost',
                '-addext',
                'subjectAltName=DNS:localhost'
            ],
            { stdio: 'ignore' }
        );
        cached = { cert: fs.readFileSync(certFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8') };
        return cached;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

export function testTlsStore(): TlsStore {
    const certificates = new TlsStore();
    certificates.set(selfSigned(), 'file');
    return certificates;
}

/** Un message minimal, en CRLF. */
export function sampleMessage(subject: string, body = 'Bonjour.', extra = ''): Buffer {
    return Buffer.from(
        [
            'From: Alice <alice@ailleurs.test>',
            'To: bob@exemple.test',
            `Subject: ${subject}`,
            'Date: Mon, 7 Sep 2026 10:00:00 +0000',
            `Message-ID: <${subject.replace(/\W/g, '')}@ailleurs.test>`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            extra,
            '',
            body,
            ''
        ]
            .filter((line, index) => line !== '' || index >= 8)
            .join('\r\n'),
        'utf8'
    );
}

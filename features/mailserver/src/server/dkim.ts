import crypto from 'node:crypto';

import type { SdkServerKeys } from '@deveye/types/sdk/server';

import type { DomainKeyRow, MailserverRepo } from './repo';

/**
 * La clé DKIM d'un domaine : RSA 2048, que tous les récepteurs savent vérifier
 * (Ed25519 ne l'est pas encore partout). La privée est scellée sous la clé du
 * serveur : la signature d'un envoi se fait sans session.
 */

function selectorOf(date: Date): string {
    return `dv${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function ensureDomainKey(
    repo: MailserverRepo,
    keys: SdkServerKeys,
    domain: { workspaceId: number; host: string }
): Promise<DomainKeyRow> {
    const held = await repo.findDomainKey(domain.host);
    if (held) return held;

    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await repo.insertDomainKey({
        workspaceId: domain.workspaceId,
        host: domain.host,
        selector: selectorOf(new Date()),
        privateKey: keys.sealBytes(Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))),
        publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    });
    // Relue plutôt que rendue : deux appels de front n'en gardent qu'une, la première écrite.
    const stored = await repo.findDomainKey(domain.host);
    if (!stored) throw new Error(`Clé DKIM de ${domain.host} illisible après écriture`);
    return stored;
}

export function openPrivateKey(keys: SdkServerKeys, row: DomainKeyRow): string | null {
    const pem = keys.openBytes(row.private_key);
    return pem === null ? null : Buffer.from(pem).toString('utf8');
}

export const dkimRecordName = (row: { selector: string; host: string }): string =>
    `${row.selector}._domainkey.${row.host}`;

export const dkimRecordValue = (row: { public_key: string }): string => `v=DKIM1; k=rsa; p=${row.public_key}`;

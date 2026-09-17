import type { SdkLogger, SdkServerKeys } from '@deveye/types/sdk/server';
import * as acme from 'acme-client';

import { now } from '../_shared';
import type { MailserverRepo } from '../repo';
import type { TlsStore } from './tls';

/**
 * Le certificat des écouteurs, obtenu chez Let's Encrypt par le défi HTTP-01 :
 * l'autorité vient lire un jeton sur `http://<hôte>/.well-known/acme-challenge/`,
 * que sert une route publique du module. Il suffit donc que le nom du serveur
 * mail arrive jusqu'à l'app par le proxy.
 */

const RENEW_BEFORE_SECONDS = 30 * 86_400;
/** Let's Encrypt plafonne les validations ratées : après un échec, on attend avant de recommencer. */
const RETRY_AFTER_SECONDS = 3_600;

export interface AcmeDeps {
    hostname: string;
    email: string;
    directory: 'production' | 'staging';
    repo: MailserverRepo;
    keys: SdkServerKeys;
    certificates: TlsStore;
    logger: SdkLogger;
}

export interface Acme {
    /** La réponse au défi pour ce jeton, ou `null`. */
    challenge(token: string): string | null;
    /** Charge le certificat gardé, et en demande un neuf s'il manque ou approche de sa fin. */
    ensure(): Promise<void>;
}

export function createAcme(deps: AcmeDeps): Acme {
    const tokens = new Map<string, string>();
    const staging = deps.directory === 'staging';
    let lastAttempt = 0;
    let working = false;

    const open = (sealed: string): Buffer | null => {
        const bytes = deps.keys.openBytes(sealed);
        return bytes === null ? null : Buffer.from(bytes);
    };

    async function accountKey(): Promise<Buffer> {
        const held = await deps.repo.getTls(deps.hostname, 'account', deps.directory);
        const opened = held ? open(held.sealed) : null;
        if (opened) return opened;
        const key = await acme.crypto.createPrivateKey();
        await deps.repo.putTls({
            hostname: deps.hostname,
            kind: 'account',
            directory: deps.directory,
            sealed: deps.keys.sealBytes(key),
            cert_pem: null,
            not_after: null
        });
        return key;
    }

    async function order(): Promise<void> {
        const client = new acme.Client({
            directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
            accountKey: await accountKey()
        });
        const [key, csr] = await acme.crypto.createCsr({ commonName: deps.hostname });
        const cert = await client.auto({
            csr,
            email: deps.email === '' ? undefined : deps.email,
            termsOfServiceAgreed: true,
            challengePriority: ['http-01'],
            // L'app ne se joint pas forcément elle-même par son nom public (NAT en épingle) : seule l'autorité vérifie.
            skipChallengeVerification: true,
            challengeCreateFn: (_authz, challenge, keyAuthorization) => {
                tokens.set(challenge.token, keyAuthorization);
                return Promise.resolve();
            },
            challengeRemoveFn: (_authz, challenge) => {
                tokens.delete(challenge.token);
                return Promise.resolve();
            }
        });
        const pem = { cert, key: key.toString() };
        deps.certificates.set(pem, 'acme', staging);
        await deps.repo.putTls({
            hostname: deps.hostname,
            kind: 'certificate',
            directory: deps.directory,
            sealed: deps.keys.sealBytes(key),
            cert_pem: cert,
            not_after: deps.certificates.info()?.notAfter ?? null
        });
        deps.logger.info({ hostname: deps.hostname, staging }, 'Serveur mail : certificat obtenu');
    }

    return {
        challenge: (token) => tokens.get(token) ?? null,

        async ensure() {
            if (working) return;
            working = true;
            try {
                if (deps.certificates.current() === null) {
                    const held = await deps.repo.getTls(deps.hostname, 'certificate', deps.directory);
                    const key = held?.cert_pem ? open(held.sealed) : null;
                    // Même proche de sa fin, il sert pendant qu'on demande le suivant.
                    if (held?.cert_pem && key && (held.not_after ?? 0) > now()) {
                        deps.certificates.set({ cert: held.cert_pem, key: key.toString() }, 'acme', staging);
                    }
                }
                const notAfter = deps.certificates.info()?.notAfter ?? 0;
                if (notAfter - now() > RENEW_BEFORE_SECONDS) return;
                if (now() - lastAttempt < RETRY_AFTER_SECONDS) return;
                lastAttempt = now();
                await order();
            } catch (error) {
                deps.certificates.lastError = (error as Error).message.slice(0, 300);
                deps.logger.warn({ err: deps.certificates.lastError }, 'Serveur mail : certificat non obtenu');
            } finally {
                working = false;
            }
        }
    };
}

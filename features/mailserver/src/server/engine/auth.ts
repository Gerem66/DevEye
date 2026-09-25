import type { SdkPlanPauses } from '@deveye/types/sdk/server';

import { isServing, now } from '../_shared';
import { hashSecret, verifySecret } from '../passwords';
import type { CredentialRow, MailboxRow, MailserverRepo } from '../repo';
import type { EventRecorder } from './events';

/**
 * L'authentification d'un client, commune à IMAP et à la soumission SMTP : le
 * mot de passe de la boîte, ou l'un de ses mots de passe d'application.
 */

export type AuthOutcome =
    | { ok: true; mailbox: MailboxRow; credential: CredentialRow | null }
    | { ok: false; reason: 'invalid' | 'throttled' };

export interface Authenticator {
    login(address: string, secret: string, ip: string, protocol: 'IMAP' | 'SMTP'): Promise<AuthOutcome>;
}

const WINDOW_SECONDS = 15 * 60;
/** Par boîte et par adresse IP, puis par adresse IP seule : un balayage d'adresses s'arrête aussi. */
const MAX_PER_TARGET = 5;
const MAX_PER_IP = 20;
/** Une session par relève toutes les deux minutes remplirait le journal : une connexion réussie s'y note une fois par heure. */
const LOGIN_NOTE_SECONDS = 3_600;

class FailureWindow {
    private readonly hits = new Map<string, number[]>();

    count(key: string, since: number): number {
        const kept = (this.hits.get(key) ?? []).filter((ts) => ts >= since);
        if (kept.length === 0) this.hits.delete(key);
        else this.hits.set(key, kept);
        return kept.length;
    }

    add(key: string, ts: number): void {
        this.hits.set(key, [...(this.hits.get(key) ?? []), ts]);
    }

    clear(key: string): void {
        this.hits.delete(key);
    }
}

export function createAuthenticator(deps: {
    repo: MailserverRepo;
    events: EventRecorder;
    pauses: SdkPlanPauses;
}): Authenticator {
    const failures = new FailureWindow();
    const noted = new Map<string, number>();
    // Vérifié quand l'adresse n'existe pas : le refus prend alors le même temps, et ne dit pas quelles adresses existent.
    const decoy = hashSecret('leurre');

    return {
        async login(rawAddress, secret, ip, protocol) {
            const address = rawAddress.trim().toLowerCase();
            const ts = now();
            const since = ts - WINDOW_SECONDS;
            const target = `${address}|${ip}`;
            if (failures.count(target, since) >= MAX_PER_TARGET || failures.count(ip, since) >= MAX_PER_IP) {
                return { ok: false, reason: 'throttled' };
            }

            const mailbox = await deps.repo.findByAddress(address);
            let credential: CredentialRow | null = null;
            let granted = false;
            if (!mailbox || !isServing(mailbox, deps.pauses)) {
                await verifySecret(secret, await decoy);
            } else if (await verifySecret(secret, mailbox.password_hash)) {
                granted = true;
            } else {
                for (const candidate of await deps.repo.listCredentials(mailbox.id)) {
                    if (await verifySecret(secret, candidate.secret_hash)) {
                        credential = candidate;
                        granted = true;
                        break;
                    }
                }
            }

            if (!granted || !mailbox) {
                failures.add(target, ts);
                failures.add(ip, ts);
                if (mailbox) {
                    await deps.events.record(mailbox, { kind: 'login_failed', peer: ip, detail: protocol });
                }
                return { ok: false, reason: 'invalid' };
            }

            failures.clear(target);
            await deps.repo.touchLogin(mailbox.id, ts);
            if (credential) await deps.repo.touchCredential(credential.id, ts);
            const noteKey = `${mailbox.id}|${ip}|${credential?.id ?? 0}|${protocol}`;
            if ((noted.get(noteKey) ?? 0) < ts - LOGIN_NOTE_SECONDS) {
                noted.set(noteKey, ts);
                await deps.events.record(mailbox, {
                    kind: 'login',
                    peer: ip,
                    detail: credential ? `${protocol} · ${credential.label}` : protocol
                });
            }
            return { ok: true, mailbox, credential };
        }
    };
}

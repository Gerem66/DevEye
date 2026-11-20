import { randomBytes } from 'node:crypto';

import type { FeatureService, SdkAccountMailMessage } from '@deveye/types/sdk/server';

import { hashPassword } from '@/auth/argon';
import type { Database } from '@/db';
import { assertAttemptAllowed, clearAttempts, recordFailedAttempt } from '@/Services/attempts';
import type Encryption from '@/Services/Encryption';
import type { Mailer } from '@/Services/mailer';
import { renderAccountMail } from '@/Services/mailLayout';
import { SecretKeyService, WrongSecretError } from '@/Services/SecretKeyService';
import { sha256hex } from '@/Utils/hash';
import { passwordResetImpossibleMail, passwordResetMail } from './mails';

/** Durée de vie du lien, écrite en clair dans le mail (« 1 h ») : les deux changent ensemble. */
export const RESET_TTL_SECONDS = 3600;
const SWEEP_MS = 10 * 60 * 1000;

interface ResetLogger {
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
}

export interface PasswordResetDeps {
    db: Pick<Database, 'users' | 'userSecretKeys' | 'passwordResets' | 'transaction'>;
    crypt: Encryption;
    mailer: Mailer;
    logger: ResetLogger;
    /** Origine de l'application, sans barre finale. */
    origin: string;
    now?: () => number;
}

export type PasswordResetCompleteResult =
    | { ok: true; userId: number; username: string; recoveryCode: string | null }
    | { ok: false; reason: 'wrong_code'; userId: number; username: string }
    | { ok: false; reason: 'not_found' | 'recovery_required' | 'impossible' };

export interface PasswordResetService extends FeatureService {
    /** Envoie le lien, s'il y a un compte à cette adresse. Ne dit jamais s'il y en a un. */
    request(email: string): Promise<void>;
    /** Le lien du mail vient d'être ouvert. `null` s'il ne mène plus à rien. */
    open(token: string): Promise<{ username: string; recoveryRequired: boolean } | null>;
    /**
     * Pose le nouveau mot de passe. Un compte chiffré par son mot de passe exige
     * son code de récupération (lève `LockedOutError` après trop d'échecs), et
     * en reçoit un nouveau. Les sessions restent à fermer par l'appelant.
     */
    complete(input: { token: string; password: string; recoveryCode?: string }): Promise<PasswordResetCompleteResult>;
    sweep(): Promise<number>;
}

const newToken = (): string => randomBytes(32).toString('base64url');

export function createPasswordResetService(deps: PasswordResetDeps): PasswordResetService {
    const { db, crypt, mailer, logger, origin } = deps;
    const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
    const secretKeys = new SecretKeyService(db as Database, crypt);
    let timer: ReturnType<typeof setInterval> | null = null;

    // Pas attendu : une adresse sans compte répond sans rien envoyer, et le
    // temps d'un envoi trahirait qu'il y en a un.
    const deliver = (to: string, message: SdkAccountMailMessage): void => {
        void mailer
            .send({ to, ...renderAccountMail(message) })
            .catch((e: Error) => logger.error({ err: e.message }, 'Envoi du mail de réinitialisation impossible'));
    };

    const sweep = async (): Promise<number> => {
        try {
            return await db.passwordResets.purgeExpired(now());
        } catch (e) {
            logger.error({ err: (e as Error).message }, 'Purge des réinitialisations expirées impossible');
            return 0;
        }
    };

    return {
        sweep,

        async request(email) {
            const address = email.trim().toLowerCase();
            const user = await db.users.findByEmail(address);
            if (!user) return;

            const keyRow = await db.userSecretKeys.get(user.id);
            const encrypted = keyRow !== null && secretKeys.isPasswordWrapped(keyRow);
            if (encrypted && !keyRow.recovery_wrapped) {
                if (mailer.configured) deliver(address, passwordResetImpossibleMail(user.username, origin));
                else
                    logger.warn(
                        { email: address },
                        'SMTP non configuré : réinitialisation impossible, compte chiffré sans code'
                    );
                return;
            }

            const token = newToken();
            await db.passwordResets.replace(user.id, sha256hex(token), now() + RESET_TTL_SECONDS);
            // En fragment : il n'atteint ni le serveur ni les journaux d'un proxy.
            const url = `${origin}/reset-password#${token}`;
            if (mailer.configured) deliver(address, passwordResetMail(user.username, url, encrypted));
            else logger.warn({ email: address, url }, 'SMTP non configuré : lien de réinitialisation');
        },

        async open(token) {
            const row = await db.passwordResets.findLive(sha256hex(token), now());
            const user = row ? await db.users.findById(row.user_id) : null;
            if (!user) return null;
            const keyRow = await db.userSecretKeys.get(user.id);
            return {
                username: user.username,
                recoveryRequired: keyRow !== null && secretKeys.isPasswordWrapped(keyRow)
            };
        },

        async complete({ token, password, recoveryCode }) {
            const row = await db.passwordResets.findLive(sha256hex(token), now());
            const user = row ? await db.users.findById(row.user_id) : null;
            if (!row || !user) return { ok: false, reason: 'not_found' };
            const keyRow = await db.userSecretKeys.get(user.id);

            if (keyRow === null || !secretKeys.isPasswordWrapped(keyRow)) {
                const passwordHash = await hashPassword(password);
                const done = await db.transaction(async (tx) => {
                    if (!(await tx.passwordResets.consume(row.id, now()))) return false;
                    await tx.users.updatePasswordHash(user.id, passwordHash);
                    return true;
                });
                return done
                    ? { ok: true, userId: user.id, username: user.username, recoveryCode: null }
                    : { ok: false, reason: 'not_found' };
            }

            // Le code a pu être retiré depuis l'envoi du lien.
            if (!keyRow.recovery_wrapped) return { ok: false, reason: 'impossible' };
            if (!recoveryCode) return { ok: false, reason: 'recovery_required' };
            const attemptKey = String(user.id);
            assertAttemptAllowed('recover', attemptKey);
            let dek: Buffer;
            try {
                dek = await secretKeys.unwrapWithRecovery(keyRow, recoveryCode);
            } catch (e) {
                if (!(e instanceof WrongSecretError)) throw e;
                recordFailedAttempt('recover', attemptKey);
                return { ok: false, reason: 'wrong_code', userId: user.id, username: user.username };
            }
            clearAttempts('recover', attemptKey);

            // Comme `secrecy.recover` : le code qui vient de servir est remplacé,
            // un code tapé quelque part a pu être vu.
            let prepared: Awaited<ReturnType<SecretKeyService['prepareWrapWithPassword']>>;
            try {
                prepared = await secretKeys.prepareWrapWithPassword(dek, password, 'generate', keyRow);
            } finally {
                dek.fill(0);
            }
            const passwordHash = await hashPassword(password);
            const done = await db.transaction(async (tx) => {
                if (!(await tx.passwordResets.consume(row.id, now()))) return false;
                await new SecretKeyService(tx, crypt).rewrapPasswordAndHash(user.id, prepared.state, passwordHash);
                return true;
            });
            if (!done) return { ok: false, reason: 'not_found' };
            if (!prepared.recoveryCode) throw new Error('recovery code was not generated');
            return { ok: true, userId: user.id, username: user.username, recoveryCode: prepared.recoveryCode };
        },

        async start() {
            if (timer) return;
            await sweep();
            timer = setInterval(() => void sweep(), SWEEP_MS);
            timer.unref();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        }
    };
}

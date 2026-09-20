import { randomBytes } from 'node:crypto';

import type { FeatureService } from '@deveye/types/sdk/server';
import type { SignupStatus } from '@deveye/types';

import type { Database } from '@/db';
import type { Mailer } from '@/Services/mailer';
import { sha256hex } from '@/Utils/hash';
import { existingAccountMail, verificationMail } from './mails';

/** Durée de vie du lien, écrite en clair dans le mail (« 2 h ») : les deux changent ensemble. */
export const SIGNUP_TTL_SECONDS = 2 * 3600;
const SWEEP_MS = 10 * 60 * 1000;

interface SignupLogger {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
}

export interface SignupDeps {
    db: Pick<Database, 'users' | 'workspaces' | 'pendingSignups' | 'transaction'>;
    mailer: Mailer;
    logger: SignupLogger;
    mode: 'open' | 'closed';
    /** Origine de l'application, sans barre finale. */
    origin: string;
    now?: () => number;
}

export type SignupStartResult =
    { ok: true; watchToken: string } | { ok: false; reason: 'closed' | 'username_taken' | 'mail_failed' };

export interface CreatedAccount {
    userId: number;
    personalWorkspaceId: number;
    username: string;
    email: string;
    role: 'user' | 'admin';
    plan: string | null;
}

export type SignupCompleteResult =
    { ok: true; account: CreatedAccount } | { ok: false; reason: 'not_found' | 'conflict' | 'closed' };

export interface SignupService extends FeatureService {
    isOpen(): Promise<boolean>;
    request(input: { username: string; email: string; plan: string | null }): Promise<SignupStartResult>;
    status(watchToken: string): Promise<SignupStatus['state']>;
    /** Le lien du mail vient d'être ouvert. `null` s'il ne mène plus à rien. */
    open(token: string): Promise<{ username: string; email: string } | null>;
    /** Crée le compte. Le mot de passe arrive déjà haché : Argon2 ne tourne pas en transaction. */
    complete(token: string, passwordHash: string): Promise<SignupCompleteResult>;
    sweep(): Promise<number>;
}

const newToken = (): string => randomBytes(32).toString('base64url');

export function createSignupService(deps: SignupDeps): SignupService {
    const { db, mailer, logger, mode, origin } = deps;
    const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
    let timer: ReturnType<typeof setInterval> | null = null;

    const isOpen = async (): Promise<boolean> => mode === 'open' || (await db.users.count()) === 0;

    const sweep = async (): Promise<number> => {
        try {
            return await db.pendingSignups.purgeExpired(now());
        } catch (e) {
            logger.error({ err: (e as Error).message }, 'Purge des inscriptions en attente impossible');
            return 0;
        }
    };

    return {
        isOpen,
        sweep,

        async request({ username, email, plan }) {
            if (!(await isOpen())) return { ok: false, reason: 'closed' };
            const address = email.trim().toLowerCase();
            const watchToken = newToken();

            // Une adresse déjà inscrite reçoit la même réponse qu'une adresse
            // neuve : cette route, ouverte à tous, ne dit pas qui a un compte.
            if (await db.users.findByEmail(address)) {
                const mail = existingAccountMail(origin);
                if (mailer.configured) {
                    await mailer
                        .send({ to: address, ...mail })
                        .catch((e: Error) => logger.error({ err: e.message }, 'Envoi du mail impossible'));
                } else {
                    logger.warn({ email: address }, 'SMTP non configuré : inscription demandée sur un compte existant');
                }
                return { ok: true, watchToken };
            }

            if (
                (await db.users.findByUsername(username)) ||
                (await db.pendingSignups.usernameHeld(username, address, now()))
            ) {
                return { ok: false, reason: 'username_taken' };
            }

            const token = newToken();
            await db.pendingSignups.replace({
                email: address,
                username,
                tokenHash: sha256hex(token),
                watchHash: sha256hex(watchToken),
                plan,
                expiresAt: now() + SIGNUP_TTL_SECONDS
            });

            // En fragment : il n'atteint ni le serveur ni les journaux d'un proxy.
            const url = `${origin}/signup/verify#${token}`;
            if (!mailer.configured) {
                logger.warn({ email: address, url }, 'SMTP non configuré : lien de validation');
                return { ok: true, watchToken };
            }
            try {
                await mailer.send({ to: address, ...verificationMail(username, url) });
            } catch (e) {
                logger.error({ err: (e as Error).message }, 'Envoi du mail de validation impossible');
                return { ok: false, reason: 'mail_failed' };
            }
            return { ok: true, watchToken };
        },

        async status(watchToken) {
            const row = await db.pendingSignups.findByWatchHash(sha256hex(watchToken));
            // Inconnu = en attente : la réponse faite à une adresse déjà inscrite
            // ne se distingue pas d'une vraie demande.
            if (!row) return 'pending';
            if (row.completed_at !== null) return 'done';
            if (Number(row.expires_at) <= now()) return 'expired';
            return row.opened_at === null ? 'pending' : 'opened';
        },

        async open(token) {
            const row = await db.pendingSignups.findLiveByTokenHash(sha256hex(token), now());
            if (!row) return null;
            await db.pendingSignups.markOpened(row.id, now());
            return { username: row.username, email: row.email };
        },

        async complete(token, passwordHash) {
            const row = await db.pendingSignups.findLiveByTokenHash(sha256hex(token), now());
            if (!row) return { ok: false, reason: 'not_found' };

            return db.transaction(async (tx): Promise<SignupCompleteResult> => {
                const existing = await tx.users.countForUpdate();
                // Une demande née sur une base vide ne survit pas à l'arrivée du
                // premier compte quand les inscriptions sont fermées.
                if (mode === 'closed' && existing > 0) return { ok: false, reason: 'closed' };
                if ((await tx.users.findByEmail(row.email)) || (await tx.users.findByUsername(row.username))) {
                    return { ok: false, reason: 'conflict' };
                }
                if (!(await tx.pendingSignups.markCompleted(row.id, now()))) return { ok: false, reason: 'not_found' };

                const role = existing === 0 ? 'admin' : 'user';
                const user = await tx.users.create({ email: row.email, username: row.username, passwordHash, role });
                // L'espace personnel ne peut pas exister avant le compte (sa FK
                // propriétaire le référence) : compte, espace, puis rattachement.
                const personal = await tx.workspaces.createPersonal(user.id, row.username);
                await tx.users.setPersonalWorkspace(user.id, personal.id);
                return {
                    ok: true,
                    account: {
                        userId: user.id,
                        personalWorkspaceId: personal.id,
                        username: row.username,
                        email: row.email,
                        role,
                        plan: row.plan
                    }
                };
            });
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

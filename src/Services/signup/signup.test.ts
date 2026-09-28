import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PendingSignupRow } from '@/db/repos/pendingSignups';
import type { MailMessage } from '@/Services/mailer';
import { renderAccountMail } from '@/Services/mailLayout';
import { createSignupService, SIGNUP_TTL_SECONDS, type SignupDeps } from './index';
import { existingAccountMail, verificationMail } from './mails';

interface FakeUser {
    id: number;
    email: string;
    username: string;
    role: string;
}

const ORIGIN = 'https://deveye.test';

function harness(options: { mode?: 'open' | 'closed'; smtp?: boolean; users?: FakeUser[] } = {}) {
    const users: FakeUser[] = [...(options.users ?? [])];
    // Le réglage des inscriptions, par origine.
    const settings = new Map<string, string>([[ORIGIN, options.mode ?? 'open']]);
    const pending: PendingSignupRow[] = [];
    const sent: MailMessage[] = [];
    const warnings: { url?: string }[] = [];
    let clock = 1_000_000;
    let nextId = 1;

    const db = {
        users: {
            count: async () => users.length,
            countForUpdate: async () => users.length,
            findByEmail: async (email: string) => users.find((u) => u.email === email) ?? null,
            findByUsername: async (username: string) => users.find((u) => u.username === username) ?? null,
            create: async (input: { email: string; username: string; role?: string }) => {
                const user = {
                    id: 100 + users.length,
                    email: input.email,
                    username: input.username,
                    role: input.role ?? 'user'
                };
                users.push(user);
                return user;
            },
            setPersonalWorkspace: async () => undefined
        },
        workspaces: { createPersonal: async (ownerUserId: number) => ({ id: ownerUserId + 1000 }) },
        pendingSignups: {
            replace: async (input: {
                email: string;
                username: string;
                tokenHash: string;
                watchHash: string;
                plan: string | null;
                termsAcceptedAt: number | null;
                expiresAt: number;
            }) => {
                const at = pending.findIndex((p) => p.email === input.email);
                if (at >= 0) pending.splice(at, 1);
                pending.push({
                    id: nextId++,
                    email: input.email,
                    username: input.username,
                    token_hash: input.tokenHash,
                    watch_hash: input.watchHash,
                    plan: input.plan,
                    terms_accepted_at: input.termsAcceptedAt,
                    opened_at: null,
                    completed_at: null,
                    expires_at: input.expiresAt,
                    created: clock
                });
            },
            findLiveByTokenHash: async (hash: string, now: number) =>
                pending.find((p) => p.token_hash === hash && p.expires_at > now && p.completed_at === null) ?? null,
            findByWatchHash: async (hash: string) => pending.find((p) => p.watch_hash === hash) ?? null,
            markOpened: async (id: number, now: number) => {
                const row = pending.find((p) => p.id === id);
                if (row && row.opened_at === null) row.opened_at = now;
            },
            markCompleted: async (id: number, now: number) => {
                const row = pending.find((p) => p.id === id);
                if (!row || row.completed_at !== null || row.expires_at <= now) return false;
                row.completed_at = now;
                return true;
            },
            usernameHeld: async (username: string, exceptEmail: string, now: number) =>
                pending.some(
                    (p) =>
                        p.username === username &&
                        p.email !== exceptEmail &&
                        p.expires_at > now &&
                        p.completed_at === null
                ),
            purgeExpired: async (now: number) => {
                const before = pending.length;
                for (let i = pending.length - 1; i >= 0; i--) {
                    const p = pending[i];
                    const dead = p.completed_at === null ? p.expires_at <= now : p.completed_at <= now - 600;
                    if (dead) pending.splice(i, 1);
                }
                return before - pending.length;
            }
        },
        instanceSettings: {
            get: async (name: string, origin: string) => {
                const value = name === 'signups' ? settings.get(origin) : undefined;
                return value === undefined ? null : { origin, value, updated: 1, updatedBy: null };
            }
        },
        transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db)
    };

    const service = createSignupService({
        db: db as unknown as SignupDeps['db'],
        mailer: {
            configured: options.smtp ?? true,
            send: async (message) => {
                sent.push(message);
            },
            verify: async () => {}
        },
        logger: {
            info: () => undefined,
            warn: (obj) => warnings.push(obj as { url?: string }),
            error: () => undefined
        },
        origin: ORIGIN,
        now: () => clock
    });

    const tokenOf = (message: MailMessage): string => /#([\w-]+)/.exec(message.text)?.[1] ?? '';
    return {
        service,
        users,
        pending,
        sent,
        warnings,
        settings,
        tokenOf,
        advance: (seconds: number) => (clock += seconds)
    };
}

const ALICE = { username: 'alice', email: 'alice@exemple.fr', plan: null, termsAcceptedAt: null };

describe("l'inscription", () => {
    it('crée le compte à la dernière étape seulement, et porte le plan jusqu’au bout', async () => {
        const h = harness();
        const asked = await h.service.request({ ...ALICE, plan: 'pro' });
        assert.ok(asked.ok);
        assert.equal(h.users.length, 0);
        assert.equal(await h.service.status(asked.watchToken), 'pending');

        const token = h.tokenOf(h.sent[0]);
        assert.deepEqual(await h.service.open(token), { username: 'alice', email: 'alice@exemple.fr' });
        assert.equal(await h.service.status(asked.watchToken), 'opened');

        const done = await h.service.complete(token, 'hash');
        assert.ok(done.ok);
        assert.equal(done.account.plan, 'pro');
        assert.equal(h.users.length, 1);
        assert.equal(await h.service.status(asked.watchToken), 'done');
    });

    it('ne dit pas qu’une adresse a déjà un compte', async () => {
        const h = harness({ users: [{ id: 1, email: 'alice@exemple.fr', username: 'autre', role: 'user' }] });
        const asked = await h.service.request(ALICE);
        assert.ok(asked.ok);
        assert.equal(h.pending.length, 0);
        assert.equal(h.sent[0].subject, 'Vous avez déjà un compte DevEye');
        assert.equal(await h.service.status(asked.watchToken), 'pending');
    });

    it('remplace la demande précédente de la même adresse, dont le lien meurt', async () => {
        const h = harness();
        await h.service.request(ALICE);
        await h.service.request(ALICE);
        assert.equal(h.pending.length, 1);
        assert.equal(await h.service.open(h.tokenOf(h.sent[0])), null);
        assert.ok(await h.service.open(h.tokenOf(h.sent[1])));
    });

    it('refuse un pseudo pris par un compte ou retenu par une autre adresse', async () => {
        const h = harness({ users: [{ id: 1, email: 'x@exemple.fr', username: 'pris', role: 'user' }] });
        assert.deepEqual(await h.service.request({ ...ALICE, username: 'pris' }), {
            ok: false,
            reason: 'username_taken'
        });
        await h.service.request(ALICE);
        assert.deepEqual(await h.service.request({ ...ALICE, email: 'bob@exemple.fr' }), {
            ok: false,
            reason: 'username_taken'
        });
    });

    it('laisse un lien expiré inerte, puis le balaie', async () => {
        const h = harness();
        const asked = await h.service.request(ALICE);
        assert.ok(asked.ok);
        const token = h.tokenOf(h.sent[0]);
        h.advance(SIGNUP_TTL_SECONDS);
        assert.equal(await h.service.open(token), null);
        assert.deepEqual(await h.service.complete(token, 'hash'), { ok: false, reason: 'not_found' });
        assert.equal(await h.service.status(asked.watchToken), 'expired');
        assert.equal(await h.service.sweep(), 1);
        assert.equal(h.pending.length, 0);
    });

    it('ne se consomme qu’une fois', async () => {
        const h = harness();
        await h.service.request(ALICE);
        const token = h.tokenOf(h.sent[0]);
        assert.ok((await h.service.complete(token, 'hash')).ok);
        assert.deepEqual(await h.service.complete(token, 'hash'), { ok: false, reason: 'not_found' });
        assert.equal(h.users.length, 1);
    });

    it('fermée, ne s’ouvre que pour le premier compte, qui naît administrateur', async () => {
        const h = harness({ mode: 'closed' });
        assert.equal(await h.service.isOpen(), true);
        await h.service.request(ALICE);
        await h.service.request({ username: 'bob', email: 'bob@exemple.fr', plan: null, termsAcceptedAt: null });

        const first = await h.service.complete(h.tokenOf(h.sent[0]), 'hash');
        assert.ok(first.ok);
        assert.equal(first.account.role, 'admin');

        assert.equal(await h.service.isOpen(), false);
        assert.deepEqual(await h.service.complete(h.tokenOf(h.sent[1]), 'hash'), { ok: false, reason: 'closed' });
        assert.deepEqual(
            await h.service.request({ username: 'eve', email: 'eve@exemple.fr', plan: null, termsAcceptedAt: null }),
            {
                ok: false,
                reason: 'closed'
            }
        );
    });

    it('suit le réglage de son origine, relu à chaque étape', async () => {
        const root = { id: 1, email: 'root@exemple.fr', username: 'root', role: 'admin' };
        const h = harness({ users: [root] });
        h.settings.delete(ORIGIN);
        h.settings.set('https://autre.test', 'open');
        assert.equal(await h.service.isOpen(), false);

        h.settings.set(ORIGIN, 'open');
        await h.service.request(ALICE);
        h.settings.set(ORIGIN, 'closed');
        assert.deepEqual(await h.service.complete(h.tokenOf(h.sent[0]), 'hash'), { ok: false, reason: 'closed' });
    });

    it('ouverte, donne le rôle ordinaire dès qu’un compte existe', async () => {
        const h = harness({ users: [{ id: 1, email: 'root@exemple.fr', username: 'root', role: 'admin' }] });
        await h.service.request(ALICE);
        const done = await h.service.complete(h.tokenOf(h.sent[0]), 'hash');
        assert.ok(done.ok);
        assert.equal(done.account.role, 'user');
    });

    it('sans SMTP, écrit le lien dans le journal au lieu de l’envoyer', async () => {
        const h = harness({ smtp: false });
        assert.ok((await h.service.request(ALICE)).ok);
        assert.equal(h.sent.length, 0);
        assert.match(h.warnings[0].url ?? '', /^https:\/\/deveye\.test\/signup\/verify#/);
    });
});

describe('les mails', () => {
    it('annoncent les 2 h et portent le lien', () => {
        const mail = renderAccountMail(verificationMail('alice', 'https://deveye.test/signup/verify#abc'));
        for (const body of [mail.text, mail.html]) {
            assert.match(body, /2 h/);
            assert.match(body, /signup\/verify#abc/);
            assert.doesNotMatch(body, /—/);
        }
    });

    it('échappent le pseudo dans le HTML', () => {
        assert.doesNotMatch(renderAccountMail(verificationMail('<b>x', 'https://deveye.test/')).html, /<b>x/);
        assert.match(renderAccountMail(existingAccountMail('https://deveye.test')).html, /Se connecter/);
    });
});

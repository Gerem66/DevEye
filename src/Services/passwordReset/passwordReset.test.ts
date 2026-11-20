import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UserSecretKeyRow } from '@deveye/types';

import { verifyPassword } from '@/auth/argon';
import type { PasswordResetRow } from '@/db/repos/passwordResets';
import type { WrapState } from '@/db/repos/userSecretKeys';
import Encryption from '@/Services/Encryption';
import type { MailMessage } from '@/Services/mailer';
import { SecretKeyService } from '@/Services/SecretKeyService';
import { createPasswordResetService, RESET_TTL_SECONDS, type PasswordResetDeps } from './index';
import { passwordResetImpossibleMail, passwordResetMail } from './mails';

const ORIGIN = 'https://deveye.test';
const crypt = new Encryption('a'.repeat(32), 'b'.repeat(32));
const keys = new SecretKeyService({} as never, crypt);

interface FakeUser {
    id: number;
    email: string;
    username: string;
    password_hash: string;
}

function serverRow(userId: number, dek: Buffer): UserSecretKeyRow {
    return {
        user_id: userId,
        dek_wrapped: crypt.sealFor('user-dek', dek, `user_secret_keys:dek:${userId}`),
        open_dek_wrapped: null,
        wrap_mode: 'server',
        kdf_salt: null,
        recovery_wrapped: null,
        recovery_salt: null,
        version: 2,
        recovery_version: 2,
        created: 0,
        updated: 0
    };
}

function rowFrom(userId: number, state: WrapState): UserSecretKeyRow {
    return {
        ...serverRow(userId, Buffer.alloc(32, 1)),
        dek_wrapped: state.dekWrapped,
        wrap_mode: state.wrapMode,
        kdf_salt: state.kdfSalt,
        recovery_wrapped: state.recoveryWrapped,
        recovery_salt: state.recoverySalt,
        version: state.version,
        recovery_version: state.recoveryVersion
    };
}

/** Un compte chiffré par son mot de passe, avec ou sans code de récupération. */
async function encryptedRow(
    userId: number,
    dek: Buffer,
    recovery: boolean
): Promise<{ row: UserSecretKeyRow; code: string | undefined }> {
    const { state, recoveryCode } = await keys.prepareWrapWithPassword(
        dek,
        'ancien-mot-de-passe',
        recovery ? 'generate' : 'none',
        serverRow(userId, dek)
    );
    return { row: rowFrom(userId, state), code: recoveryCode };
}

function harness(options: { users: FakeUser[]; keyRows?: UserSecretKeyRow[]; smtp?: boolean }) {
    const users = options.users;
    const keyRows = new Map((options.keyRows ?? []).map((r) => [r.user_id, r]));
    const resets: PasswordResetRow[] = [];
    const sent: MailMessage[] = [];
    const warnings: { url?: string }[] = [];
    let clock = 1_000_000;
    let nextId = 1;

    const db = {
        users: {
            findByEmail: async (email: string) => users.find((u) => u.email === email) ?? null,
            findById: async (id: number) => users.find((u) => u.id === id) ?? null,
            updatePasswordHash: async (id: number, hash: string) => {
                const user = users.find((u) => u.id === id);
                if (user) user.password_hash = hash;
            }
        },
        userSecretKeys: {
            get: async (userId: number) => keyRows.get(userId) ?? null,
            setWrap: async (userId: number, state: WrapState) => void keyRows.set(userId, rowFrom(userId, state))
        },
        passwordResets: {
            replace: async (userId: number, tokenHash: string, expiresAt: number) => {
                const at = resets.findIndex((r) => r.user_id === userId);
                if (at >= 0) resets.splice(at, 1);
                resets.push({
                    id: nextId++,
                    user_id: userId,
                    token_hash: tokenHash,
                    expires_at: expiresAt,
                    created: clock
                });
            },
            findLive: async (hash: string, now: number) =>
                resets.find((r) => r.token_hash === hash && r.expires_at > now) ?? null,
            consume: async (id: number, now: number) => {
                const at = resets.findIndex((r) => r.id === id && r.expires_at > now);
                if (at < 0) return false;
                resets.splice(at, 1);
                return true;
            },
            removeAllOf: async () => undefined,
            purgeExpired: async () => 0
        },
        transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db)
    };

    const service = createPasswordResetService({
        db: db as unknown as PasswordResetDeps['db'],
        crypt,
        mailer: {
            configured: options.smtp ?? true,
            send: async (message) => void sent.push(message),
            verify: async () => {}
        },
        logger: { warn: (obj) => warnings.push(obj as { url?: string }), error: () => undefined },
        origin: ORIGIN,
        now: () => clock
    });

    const tokenOf = (message: MailMessage): string => /reset-password#([\w-]+)/.exec(message.text)?.[1] ?? '';
    return { service, users, keyRows, resets, sent, warnings, tokenOf, advance: (s: number) => (clock += s) };
}

const user = (id: number): FakeUser => ({
    id,
    email: `compte${id}@exemple.fr`,
    username: `compte${id}`,
    password_hash: 'ancien'
});

describe('la réinitialisation du mot de passe', () => {
    it('n’envoie rien à une adresse sans compte', async () => {
        const h = harness({ users: [user(1)] });
        await h.service.request('personne@exemple.fr');
        assert.equal(h.sent.length, 0);
        assert.equal(h.resets.length, 0);
    });

    it('change le mot de passe d’un compte non chiffré, et le lien ne sert qu’une fois', async () => {
        const h = harness({ users: [user(1)] });
        await h.service.request(' Compte1@Exemple.fr ');
        assert.equal(h.sent[0].subject, passwordResetMail('', '', false).subject);
        const token = h.tokenOf(h.sent[0]);
        assert.deepEqual(await h.service.open(token), { username: 'compte1', recoveryRequired: false });

        const done = await h.service.complete({ token, password: 'nouveau-mot-de-passe' });
        assert.deepEqual(done, { ok: true, userId: 1, username: 'compte1', recoveryCode: null });
        assert.ok(await verifyPassword(h.users[0].password_hash, 'nouveau-mot-de-passe'));
        assert.equal(await h.service.open(token), null);
        assert.deepEqual(await h.service.complete({ token, password: 'encore-un-autre' }), {
            ok: false,
            reason: 'not_found'
        });
    });

    it('exige le code d’un compte chiffré, garde sa DEK et en remet un nouveau', async () => {
        const dek = Buffer.alloc(32, 7);
        const { row, code } = await encryptedRow(2, dek, true);
        assert.ok(code);
        const h = harness({ users: [user(2)], keyRows: [row] });
        await h.service.request('compte2@exemple.fr');
        assert.ok(h.sent[0].text.includes('code de récupération'));
        const token = h.tokenOf(h.sent[0]);
        assert.deepEqual(await h.service.open(token), { username: 'compte2', recoveryRequired: true });

        assert.deepEqual(await h.service.complete({ token, password: 'nouveau-mot-de-passe' }), {
            ok: false,
            reason: 'recovery_required'
        });
        assert.deepEqual(
            await h.service.complete({ token, password: 'nouveau-mot-de-passe', recoveryCode: 'AAAA-AAAA-AAAA-AAAA' }),
            { ok: false, reason: 'wrong_code', userId: 2, username: 'compte2' }
        );
        assert.ok(await h.service.open(token), 'un mauvais code laisse le lien vivant');

        const done = await h.service.complete({ token, password: 'nouveau-mot-de-passe', recoveryCode: code });
        assert.ok(done.ok);
        assert.ok(done.recoveryCode && done.recoveryCode !== code);
        const rewrapped = h.keyRows.get(2);
        assert.ok(rewrapped);
        assert.deepEqual(await keys.unwrapWithPassword(rewrapped, 'nouveau-mot-de-passe'), dek);
        assert.deepEqual(await keys.unwrapWithRecovery(rewrapped, done.recoveryCode), dek);
        assert.ok(await verifyPassword(h.users[0].password_hash, 'nouveau-mot-de-passe'));
        assert.equal(await h.service.open(token), null);
    });

    it('prévient un compte chiffré sans code qu’il ne peut pas être réinitialisé', async () => {
        const { row } = await encryptedRow(3, Buffer.alloc(32, 9), false);
        const h = harness({ users: [user(3)], keyRows: [row] });
        await h.service.request('compte3@exemple.fr');
        assert.equal(h.sent[0].subject, passwordResetImpossibleMail('', '').subject);
        assert.equal(h.resets.length, 0);
    });

    it('fait mourir le lien remplacé et le lien expiré', async () => {
        const h = harness({ users: [user(4)] });
        await h.service.request('compte4@exemple.fr');
        await h.service.request('compte4@exemple.fr');
        assert.equal(h.resets.length, 1);
        assert.equal(await h.service.open(h.tokenOf(h.sent[0])), null);
        const token = h.tokenOf(h.sent[1]);
        assert.ok(await h.service.open(token));
        h.advance(RESET_TTL_SECONDS);
        assert.equal(await h.service.open(token), null);
    });

    it('écrit le lien dans le journal sans SMTP', async () => {
        const h = harness({ users: [user(5)], smtp: false });
        await h.service.request('compte5@exemple.fr');
        assert.equal(h.sent.length, 0);
        assert.match(h.warnings[0]?.url ?? '', /^https:\/\/deveye\.test\/reset-password#[\w-]+$/);
    });
});

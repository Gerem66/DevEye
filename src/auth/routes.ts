import {
    changePasswordRequestSchema,
    err,
    loginRequestSchema,
    loginResponseSchema,
    ok,
    registerRequestSchema,
    twoFactorChallengeRequestSchema
} from 'deveye-types';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { env } from '@/Utils/Env';
import { sha256hex } from '@/Utils/hash';
import { normalizeBackupCode, verifyTotp } from '@/Services/Totp';
import type Encryption from '@/Services/Encryption';
import { SecretKeyService, WrongSecretError } from '@/Services/SecretKeyService';
import {
    claimPendingDek,
    DEFAULT_DEK_GRACE_MS,
    discardPendingDek,
    rememberSessionDek,
    stashPendingDek
} from '@/Services/SecureStore';
import { hashPassword, needsRehash, verifyPassword } from './argon';
import {
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    TWOFA_COOKIE,
    clearAuthCookies,
    clearTwoFactorChallengeCookie,
    setAuthCookies,
    setTwoFactorChallengeCookie
} from './cookies';
import {
    signAccessToken,
    signRefreshToken,
    signTwoFactorChallenge,
    verifyAccessToken,
    verifyRefreshToken,
    verifyTwoFactorChallenge
} from './jwt';
import { loadUserBundle } from './loadUserBundle';

import type { Database } from '@/db';

interface AuthDeps {
    db: Database;
    crypt: Encryption;
}

/**
 * Grace window (seconds) during which an already-rotated refresh token is treated
 * as a benign concurrent use (page reload, multiple tabs sharing the cookie)
 * rather than theft. Keeps the session alive instead of revoking it.
 */
const ROTATION_GRACE_SECONDS = 30;

async function issueSession(reply: FastifyReply, db: Database, userId: number): Promise<string> {
    const sessionId = db.refreshTokens.newSessionId();
    const access = await signAccessToken(userId, sessionId);
    const refresh = await signRefreshToken(userId, sessionId);
    const expiresAt = Math.floor(Date.now() / 1000) + env.JWT_REFRESH_TTL_SECONDS;
    await db.refreshTokens.store({
        jti: refresh.jti,
        userId,
        sessionId,
        token: refresh.token,
        expiresAt
    });
    setAuthCookies(reply, access, refresh.token);
    return sessionId;
}

/**
 * Resolve the grace window (ms) for a freshly logged-in user from their
 * configured re-auth interval. Mirrors the secrecy feature: `null` → server
 * default, otherwise seconds → ms. `0` means "never cache".
 */
function loginGraceMs(reAuthIntervalSeconds: number | null): number {
    return reAuthIntervalSeconds === null ? DEFAULT_DEK_GRACE_MS : reAuthIntervalSeconds * 1000;
}

/**
 * Unwrap the user's DEK at login so the imminent WS session starts already
 * unlocked — no second password prompt right after signing in. Returns the DEK
 * and the grace window, or `null` when there's nothing to pre-cache:
 *  - the feature is off (DEK is server-wrapped; no prompt happens anyway), or
 *  - the user set a `0` re-auth interval (they explicitly want every action to
 *    re-prompt), or
 *  - the password no longer unwraps the DEK (defensive; never blocks login).
 *
 * Critically this only runs on a real login (the POST that carries the
 * password). A page reload / auto-login reuses the access cookie and never hits
 * these routes, so it never pre-caches — exactly the intended behavior.
 */
async function unwrapDekForLogin(
    db: Database,
    crypt: Encryption,
    userId: number,
    password: string
): Promise<{ dek: Buffer; graceMs: number } | null> {
    const keys = new SecretKeyService(db, crypt);
    try {
        const row = await keys.ensureRow(userId);
        if (!keys.isPasswordWrapped(row)) return null;
        const user = await db.users.findById(userId);
        const graceMs = loginGraceMs(user?.re_auth_interval ?? null);
        if (graceMs <= 0) return null;
        const dek = await keys.unwrapWithPassword(row, password);
        return { dek, graceMs };
    } catch {
        // A wrong-secret or any failure here must never break login; the user
        // will simply be prompted to unlock on first encrypted access.
        return null;
    }
}

export async function authRoutes(app: FastifyInstance, { db, crypt }: AuthDeps): Promise<void> {
    app.post('/api/auth/register', async (req, reply) => {
        const parsed = registerRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid registration payload', parsed.error.flatten()));
        }
        const { username, email, password } = parsed.data;

        const [existingByName, existingByEmail] = await Promise.all([
            db.users.findByUsername(username),
            db.users.findByEmail(email)
        ]);
        if (existingByName || existingByEmail) {
            return reply.code(409).send(err('conflict', 'Username or email already in use'));
        }

        const passwordHash = await hashPassword(password);
        const row = await db.users.create({ email, username, passwordHash, role: 'user' });

        await issueSession(reply, db, row.id);
        const bundle = await loadUserBundle(db, row.id);
        if (!bundle) {
            return reply.code(500).send(err('internal', 'Unable to load user'));
        }
        return reply.send(ok(loginResponseSchema.parse({ twoFactorRequired: false, ...bundle })));
    });

    app.post('/api/auth/login', async (req, reply) => {
        const parsed = loginRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid login payload', parsed.error.flatten()));
        }
        const { username, password } = parsed.data;

        const row = await db.users.findByUsername(username);
        if (!row) {
            return reply.code(401).send(err('auth_invalid', 'Invalid credentials'));
        }

        const valid = row.password_hash ? await verifyPassword(row.password_hash, password) : false;
        if (!valid) {
            return reply.code(401).send(err('auth_invalid', 'Invalid credentials'));
        }

        // Transparently upgrade legacy (bcrypt) hashes to argon2 after a successful login.
        if (row.password_hash && needsRehash(row.password_hash)) {
            try {
                await db.users.updatePasswordHash(row.id, await hashPassword(password));
            } catch (e) {
                req.log.warn({ err: (e as Error).message, userId: row.id }, 'Password rehash failed');
            }
        }

        // Unwrap the DEK now, while we hold the password, so the session starts
        // unlocked (no double prompt). Skipped when the feature is off or the
        // user opted into per-action re-prompts.
        const pending = await unwrapDekForLogin(db, crypt, row.id, password);

        // If 2FA is enabled, defer session issuance behind a TOTP challenge.
        const twoFa = await db.twoFactor.get(row.id);
        if (twoFa?.enabled) {
            // The session doesn't exist yet; hold the DEK server-side and carry an
            // opaque reference through the challenge for the TOTP step to claim.
            const pdkToken = pending ? stashPendingDek(row.id, pending.dek, pending.graceMs) : undefined;
            const challenge = await signTwoFactorChallenge(row.id, pdkToken);
            setTwoFactorChallengeCookie(reply, challenge);
            return reply.send(ok(loginResponseSchema.parse({ twoFactorRequired: true })));
        }

        await db.users.updateLastLogin(row.id, Math.floor(Date.now() / 1000));
        const bundle = await loadUserBundle(db, row.id);
        if (!bundle) {
            return reply.code(500).send(err('internal', 'Unable to load user'));
        }

        const sessionId = await issueSession(reply, db, row.id);
        if (pending) rememberSessionDek(sessionId, pending.dek, pending.graceMs);
        return reply.send(ok(loginResponseSchema.parse({ twoFactorRequired: false, ...bundle })));
    });

    app.post('/api/auth/2fa/challenge', async (req, reply) => {
        const challengeToken = req.cookies[TWOFA_COOKIE];
        if (!challengeToken) {
            return reply.code(401).send(err('auth_required', 'No 2FA challenge in progress'));
        }
        const challenge = await verifyTwoFactorChallenge(challengeToken);
        if (!challenge) {
            clearTwoFactorChallengeCookie(reply);
            return reply.code(401).send(err('auth_expired', '2FA challenge expired'));
        }

        const parsed = twoFactorChallengeRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid 2FA payload', parsed.error.flatten()));
        }

        const userId = Number(challenge.sub);
        const twoFa = await db.twoFactor.get(userId);
        if (!twoFa?.enabled) {
            clearTwoFactorChallengeCookie(reply);
            // Terminal: no session will be issued, so release any DEK we stashed
            // at the password step instead of letting it linger until its TTL.
            if (challenge.pendingDekToken) discardPendingDek(challenge.pendingDekToken);
            return reply.code(400).send(err('conflict', '2FA is not enabled'));
        }

        const code = parsed.data.code.trim();
        const secret = crypt.Decrypt(twoFa.secret_enc);
        let accepted = false;
        if (secret && verifyTotp(code, secret)) {
            accepted = true;
        } else {
            // Fall back to single-use recovery codes.
            const codeHash = sha256hex(normalizeBackupCode(code));
            const backup = await db.twoFactor.findUnusedBackupCode(userId, codeHash);
            if (backup) {
                await db.twoFactor.markBackupCodeUsed(backup.id);
                accepted = true;
            }
        }

        if (!accepted) {
            return reply.code(401).send(err('auth_invalid', 'Invalid 2FA code'));
        }

        clearTwoFactorChallengeCookie(reply);
        await db.users.updateLastLogin(userId, Math.floor(Date.now() / 1000));
        const bundle = await loadUserBundle(db, userId);
        if (!bundle) {
            return reply.code(500).send(err('internal', 'Unable to load user'));
        }
        const sessionId = await issueSession(reply, db, userId);
        // Bind the DEK unwrapped at the password step (if any) to this session.
        if (challenge.pendingDekToken) {
            const pending = claimPendingDek(challenge.pendingDekToken);
            if (pending) rememberSessionDek(sessionId, pending.dek, pending.graceMs);
        }
        return reply.send(ok(loginResponseSchema.parse({ twoFactorRequired: false, ...bundle })));
    });

    /**
     * Abandon an in-progress 2FA challenge ("Back" on the prompt): clear the
     * challenge cookie and release any DEK stashed at the password step so it
     * doesn't linger until its TTL. Always succeeds — a missing/expired challenge
     * is a no-op so the client can call it unconditionally on Back.
     */
    app.post('/api/auth/2fa/cancel', async (req, reply) => {
        const challengeToken = req.cookies[TWOFA_COOKIE];
        if (challengeToken) {
            const challenge = await verifyTwoFactorChallenge(challengeToken);
            if (challenge?.pendingDekToken) discardPendingDek(challenge.pendingDekToken);
        }
        clearTwoFactorChallengeCookie(reply);
        return reply.send(ok({ cancelled: true as const }));
    });

    app.post('/api/auth/refresh', async (req, reply) => {
        const token = req.cookies[REFRESH_COOKIE];
        if (!token) return reply.code(401).send(err('auth_required', 'Missing refresh cookie'));

        const claims = await verifyRefreshToken(token);
        if (!claims) {
            clearAuthCookies(reply);
            return reply.code(401).send(err('auth_invalid', 'Invalid refresh token'));
        }

        const valid = await db.refreshTokens.isValid(claims.jti, token);
        if (valid) {
            await db.refreshTokens.revoke(claims.jti);
        } else {
            // The token is no longer the active one. Within a short grace window this
            // is a benign concurrent rotation (reload / multiple tabs share cookies),
            // not theft — keep the session alive. Outside the window, treat as reuse.
            const benign = await db.refreshTokens.wasRecentlyRotated(claims.jti, token, ROTATION_GRACE_SECONDS);
            if (!benign) {
                await db.refreshTokens.revokeSession(claims.sid);
                clearAuthCookies(reply);
                return reply.code(401).send(err('auth_expired', 'Refresh token reuse detected'));
            }
        }

        const userId = Number(claims.sub);
        const bundle = await loadUserBundle(db, userId);
        if (!bundle) {
            clearAuthCookies(reply);
            return reply.code(401).send(err('auth_invalid', 'Unknown user'));
        }

        await issueSession(reply, db, userId);
        return reply.send(ok(bundle));
    });

    app.post('/api/auth/logout', async (req, reply) => {
        const token = req.cookies[REFRESH_COOKIE];
        if (token) {
            const claims = await verifyRefreshToken(token);
            if (claims) await db.refreshTokens.revokeSession(claims.sid);
        }
        clearAuthCookies(reply);
        return reply.send(ok({ loggedOut: true }));
    });

    app.get('/api/auth/me', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));

        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const bundle = await loadUserBundle(db, Number(claims.sub));
        if (!bundle) return reply.code(401).send(err('auth_invalid', 'Unknown user'));

        return reply.send(ok(bundle));
    });

    app.post('/api/auth/change-password', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));

        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const parsed = changePasswordRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid password payload', parsed.error.flatten()));
        }
        const { currentPassword, newPassword } = parsed.data;

        const row = await db.users.findById(Number(claims.sub));
        if (!row) return reply.code(401).send(err('auth_invalid', 'Unknown user'));

        const valid = row.password_hash ? await verifyPassword(row.password_hash, currentPassword) : false;
        if (!valid) {
            return reply.code(401).send(err('auth_invalid', 'Current password is incorrect'));
        }

        if (currentPassword === newPassword) {
            return reply.code(400).send(err('validation', 'New password must differ from the current one'));
        }

        // If password-based encryption is on, the DEK is wrapped by the current
        // password. Re-wrap it with the new password before rotating the hash so
        // the user keeps access to their encrypted data (content is untouched).
        const secretKeys = new SecretKeyService(db, crypt);
        const keyRow = await db.userSecretKeys.get(row.id);
        if (keyRow && secretKeys.isPasswordWrapped(keyRow)) {
            try {
                const dek = await secretKeys.unwrapWithPassword(keyRow, currentPassword);
                await secretKeys.wrapWithPassword(row.id, dek, newPassword, 'keep', keyRow);
            } catch (e) {
                if (e instanceof WrongSecretError) {
                    return reply.code(401).send(err('auth_invalid', 'Current password is incorrect'));
                }
                throw e;
            }
        }

        await db.users.updatePasswordHash(row.id, await hashPassword(newPassword));

        return reply.send(ok({ changed: true as const }));
    });
}

import { err, loginRequestSchema, loginResponseSchema, ok } from 'deveye-types';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { env } from '@/Utils/Env';
import { hashPassword, needsRehash, verifyPassword } from './argon';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './cookies';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from './jwt';
import { loadUserBundle } from './loadUserBundle';

import type { Database } from '@/db';

interface AuthDeps {
    db: Database;
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

export async function authRoutes(app: FastifyInstance, { db }: AuthDeps): Promise<void> {
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

        await db.users.updateLastLogin(row.id, Math.floor(Date.now() / 1000));
        const bundle = await loadUserBundle(db, row.id);
        if (!bundle) {
            return reply.code(500).send(err('internal', 'Unable to load user'));
        }

        await issueSession(reply, db, row.id);
        const body = loginResponseSchema.parse(bundle);
        return reply.send(ok(body));
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
}

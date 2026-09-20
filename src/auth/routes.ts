import {
    changePasswordRequestSchema,
    err,
    loginRequestSchema,
    loginResponseSchema,
    ok,
    twoFactorChallengeRequestSchema
} from '@deveye/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { randomBytes } from 'node:crypto';

import { sha256hex } from '@/Utils/hash';
import {
    assertAttemptAllowed,
    clearAttempts,
    LockedOutError,
    recordFailedAttempt,
    type AttemptScope
} from '@/Services/attempts';
import { totpContext } from '@/Services/sealContexts';
import { hashBackupCode, verifyTotp } from '@/Services/Totp';
import type Encryption from '@/Services/Encryption';
import { SecretKeyService, WrongSecretError } from '@/Services/SecretKeyService';
import {
    claimPendingDek,
    DEFAULT_DEK_GRACE_MS,
    discardPendingDek,
    forgetSessionDek,
    forgetSessionsOf,
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
    setTwoFactorChallengeCookie
} from './cookies';
import { signTwoFactorChallenge, verifyAccessToken, verifyRefreshToken, verifyTwoFactorChallenge } from './jwt';
import { loadUserBundle } from './loadUserBundle';
import { issueSession } from './session';

import type { AuditLog } from '@/Services/AuditLog';
import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';

interface AuthDeps {
    db: Database;
    crypt: Encryption;
    audit: AuditLog;
    live: LiveHub;
}

/**
 * Grace window (seconds) during which an already-rotated refresh token is treated
 * as a benign concurrent use (page reload, multiple tabs sharing the cookie)
 * rather than theft. Keeps the session alive instead of revoking it.
 */
const ROTATION_GRACE_SECONDS = 30;

/** Codes 2FA faux tolérés sur un même challenge avant de l'annuler. */
const TWOFA_CHALLENGE_MAX_FAILURES = 5;

/**
 * Un hachage Argon2id de même profil que les vrais, vérifié quand l'identifiant
 * n'existe pas : sans lui, un compte connu coûte une vérification Argon2 et un
 * inconnu rien, et le temps de réponse dit qui existe.
 */
const dummyHash: Promise<string> = hashPassword(randomBytes(32).toString('hex'));

/** Le refus d'une cible verrouillée, sous la forme HTTP. `false` = pas verrouillée. */
function lockedOut(reply: FastifyReply, scope: AttemptScope, key: string): FastifyReply | false {
    try {
        assertAttemptAllowed(scope, key);
        return false;
    } catch (e) {
        if (!(e instanceof LockedOutError)) throw e;
        return reply
            .code(429)
            .header('retry-after', Math.ceil(e.retryAfterMs / 1000))
            .send(err('rate_limited', e.message, { retryAfterMs: e.retryAfterMs }));
    }
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
 * unlocked. Returns `null` when there's nothing to pre-cache: feature off, a `0`
 * re-auth interval, or a password that no longer unwraps the DEK (never blocks
 * login). Only runs on a real login: a reload reuses the access cookie.
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
        // Le mot de passe est en main : une ligne dérivée sous un ancien profil
        // Argon2 monte au profil courant.
        if (keys.needsKdfUpgrade(row)) await keys.wrapWithPassword(userId, dek, password, 'keep', row);
        return { dek, graceMs };
    } catch {
        // A wrong-secret or any failure here must never break login; the user
        // will simply be prompted to unlock on first encrypted access.
        return null;
    }
}

export async function authRoutes(app: FastifyInstance, { db, crypt, audit, live }: AuthDeps): Promise<void> {
    app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
        const parsed = loginRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid login payload', parsed.error.flatten()));
        }
        const { username, password } = parsed.data;
        // Verrouillé par identifiant, connu ou non : la réponse reste la même.
        const attemptKey = username.trim().toLowerCase();
        const locked = lockedOut(reply, 'login', attemptKey);
        if (locked) return locked;

        const row = await db.users.findByUsername(username);
        if (!row) {
            await verifyPassword(await dummyHash, password);
            recordFailedAttempt('login', attemptKey);
            // L'identifiant saisi n'est pas gardé tel quel : on y tape souvent
            // son mot de passe par erreur, et l'audit se lit par tout administrateur.
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.failed',
                level: 'warning',
                uid: 0,
                ip: req.ip,
                description: 'Échec de connexion : identifiant inconnu',
                metadata: {
                    usernameRef: sha256hex(attemptKey).slice(0, 16),
                    usernameLength: username.length,
                    reason: 'unknown_user'
                }
            });
            return reply.code(401).send(err('auth_invalid', 'Invalid credentials'));
        }

        const valid = row.password_hash ? await verifyPassword(row.password_hash, password) : false;
        if (!valid) {
            recordFailedAttempt('login', attemptKey);
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.failed',
                level: 'warning',
                uid: row.id,
                ip: req.ip,
                description: `Échec de connexion : mot de passe incorrect pour « ${username} »`,
                metadata: { username, reason: 'bad_password' }
            });
            return reply.code(401).send(err('auth_invalid', 'Invalid credentials'));
        }

        clearAttempts('login', attemptKey);

        // Le compte est suspendu : identifiants corrects, mais pas d'accès. On le
        // vérifie APRÈS le mot de passe, pour ne pas révéler l'existence d'un
        // compte à qui n'en connaît pas les identifiants.
        if (row.status === 'suspended') {
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.suspended',
                level: 'warning',
                uid: row.id,
                ip: req.ip,
                description: `Connexion refusée : compte suspendu « ${username} »`,
                metadata: { username }
            });
            return reply.code(403).send(err('forbidden', 'Ce compte est suspendu. Contactez un administrateur.'));
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
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.2fa_required',
                level: 'info',
                uid: row.id,
                ip: req.ip,
                description: `Mot de passe validé pour « ${username} » ; en attente du code 2FA`
            });
            return reply.send(ok(loginResponseSchema.parse({ twoFactorRequired: true })));
        }

        await db.users.updateLastLogin(row.id, Math.floor(Date.now() / 1000));
        const bundle = await loadUserBundle(db, row.id);
        if (!bundle) {
            return reply.code(500).send(err('internal', 'Unable to load user'));
        }

        const sessionId = await issueSession(reply, db, row.id);
        if (pending) rememberSessionDek(sessionId, row.id, pending.dek, pending.graceMs);
        audit.record({
            source: 'web',
            category: 'auth',
            action: 'login.success',
            level: 'info',
            uid: row.id,
            ip: req.ip,
            description: `Connexion réussie : ${username}`
        });
        return reply.send(ok(loginResponseSchema.parse({ twoFactorRequired: false, ...bundle })));
    });

    app.post(
        '/api/auth/2fa/challenge',
        {
            config: {
                rateLimit: {
                    max: 10,
                    timeWindow: '5 minutes',
                    // Par challenge et non par adresse : c'est lui qu'on devine.
                    keyGenerator: (req: FastifyRequest) => sha256hex(req.cookies[TWOFA_COOKIE] ?? req.ip)
                }
            }
        },
        async (req, reply) => {
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

            const locked = lockedOut(reply, 'twofa', String(userId));
            if (locked) return locked;

            const code = parsed.data.code.trim();
            const secret = crypt.openTextFor('totp', twoFa.secret_enc, totpContext(userId));
            const step = secret ? verifyTotp(code, secret, twoFa.last_used_counter) : null;
            let accepted = step !== null && (await db.twoFactor.claimTotpCounter(userId, step));
            if (!accepted) {
                // Fall back to single-use recovery codes.
                const backup = await db.twoFactor.findUnusedBackupCode(userId, hashBackupCode(crypt, code));
                accepted = backup !== null && (await db.twoFactor.markBackupCodeUsed(backup.id));
            }

            if (!accepted) {
                const failures = recordFailedAttempt('twofa', String(userId));
                // Un challenge ne se devine pas cinq minutes durant : passé le seuil il
                // tombe, et la DEK mise de côté à l'étape du mot de passe avec lui.
                const exhausted = failures >= TWOFA_CHALLENGE_MAX_FAILURES;
                if (exhausted) {
                    clearTwoFactorChallengeCookie(reply);
                    if (challenge.pendingDekToken) discardPendingDek(challenge.pendingDekToken);
                }
                audit.record({
                    source: 'web',
                    category: 'auth',
                    action: exhausted ? 'login.2fa_locked' : 'login.2fa_failed',
                    level: 'warning',
                    uid: userId,
                    ip: req.ip,
                    description: exhausted
                        ? 'Échec de connexion : trop de codes 2FA invalides, challenge annulé'
                        : 'Échec de connexion : code 2FA invalide'
                });
                return exhausted
                    ? reply.code(401).send(err('auth_expired', '2FA challenge cancelled after too many attempts'))
                    : reply.code(401).send(err('auth_invalid', 'Invalid 2FA code'));
            }

            clearAttempts('twofa', String(userId));
            clearTwoFactorChallengeCookie(reply);
            await db.users.updateLastLogin(userId, Math.floor(Date.now() / 1000));
            const bundle = await loadUserBundle(db, userId);
            if (!bundle) {
                return reply.code(500).send(err('internal', 'Unable to load user'));
            }
            const sessionId = await issueSession(reply, db, userId);
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.success',
                level: 'info',
                uid: userId,
                ip: req.ip,
                description: 'Connexion réussie (2FA validée)',
                metadata: { twoFactor: true }
            });
            // Bind the DEK unwrapped at the password step (if any) to this session.
            if (challenge.pendingDekToken) {
                const pending = claimPendingDek(challenge.pendingDekToken);
                if (pending) rememberSessionDek(sessionId, userId, pending.dek, pending.graceMs);
            }
            return reply.send(ok(loginResponseSchema.parse({ twoFactorRequired: false, ...bundle })));
        }
    );

    /**
     * Abandon an in-progress 2FA challenge: clear the cookie and release any DEK
     * stashed at the password step. Always succeeds, so the client can call it
     * unconditionally.
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

    /**
     * Espace où le client se trouve (`?workspace=`) : sans lui, `/me` et
     * `/refresh` renverraient thème, disposition et droits d'un autre espace.
     * Un id inaccessible est simplement ignoré.
     */
    const requestedWorkspace = (req: FastifyRequest): number | undefined => {
        // Un paramètre répété arrive en tableau : seule une chaîne est lue.
        const raw = (req.query as Record<string, unknown> | undefined)?.workspace;
        if (typeof raw !== 'string') return undefined;
        const id = Number(raw);
        return Number.isInteger(id) && id > 0 ? id : undefined;
    };

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
                forgetSessionDek(claims.sid);
                live.closeSession(claims.sid);
                clearAuthCookies(reply);
                audit.record({
                    source: 'web',
                    category: 'auth',
                    action: 'token.reuse_detected',
                    level: 'critical',
                    uid: Number(claims.sub),
                    ip: req.ip,
                    description: 'Réutilisation de jeton de rafraîchissement détectée ; session révoquée',
                    metadata: { sessionId: claims.sid }
                });
                return reply.code(401).send(err('auth_expired', 'Refresh token reuse detected'));
            }
        }

        const userId = Number(claims.sub);
        const bundle = await loadUserBundle(db, userId, requestedWorkspace(req));
        if (!bundle) {
            clearAuthCookies(reply);
            return reply.code(401).send(err('auth_invalid', 'Unknown user'));
        }

        await issueSession(reply, db, userId, claims.sid);
        return reply.send(ok(bundle));
    });

    app.post('/api/auth/logout', async (req, reply) => {
        const token = req.cookies[REFRESH_COOKIE];
        if (token) {
            const claims = await verifyRefreshToken(token);
            if (claims) {
                await db.refreshTokens.revokeSession(claims.sid);
                // La socket s'est authentifiée une fois pour toutes : sans la
                // fermer, elle servirait encore le coffre après la déconnexion.
                forgetSessionDek(claims.sid);
                live.closeSession(claims.sid);
                audit.record({
                    source: 'web',
                    category: 'auth',
                    action: 'logout',
                    level: 'info',
                    uid: Number(claims.sub),
                    ip: req.ip,
                    description: 'Déconnexion'
                });
            }
        }
        clearAuthCookies(reply);
        return reply.send(ok({ loggedOut: true }));
    });

    app.get('/api/auth/me', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));

        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const bundle = await loadUserBundle(db, Number(claims.sub), requestedWorkspace(req));
        if (!bundle) return reply.code(401).send(err('auth_invalid', 'Unknown user'));

        return reply.send(ok(bundle));
    });

    app.post(
        '/api/auth/change-password',
        { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
        async (req, reply) => {
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

            const attemptKey = String(row.id);
            const locked = lockedOut(reply, 'password', attemptKey);
            if (locked) return locked;
            const refuse = (): FastifyReply => {
                recordFailedAttempt('password', attemptKey);
                audit.record({
                    source: 'web',
                    category: 'auth',
                    action: 'password.change_failed',
                    level: 'warning',
                    uid: row.id,
                    ip: req.ip,
                    description: `Changement de mot de passe refusé pour « ${row.username} » : mot de passe actuel incorrect`
                });
                return reply.code(401).send(err('auth_invalid', 'Current password is incorrect'));
            };

            const valid = row.password_hash ? await verifyPassword(row.password_hash, currentPassword) : false;
            if (!valid) return refuse();

            if (currentPassword === newPassword) {
                return reply.code(400).send(err('validation', 'New password must differ from the current one'));
            }

            // If password-based encryption is on, the DEK is wrapped by the current
            // password: the new wrap and the new hash land in one transaction, so the
            // vault and the login never disagree on which password is current. The
            // Argon2 work is done before it opens (no connection held meanwhile).
            const secretKeys = new SecretKeyService(db, crypt);
            const keyRow = await db.userSecretKeys.get(row.id);
            const newHash = await hashPassword(newPassword);
            if (keyRow && secretKeys.isPasswordWrapped(keyRow)) {
                let dek: Buffer;
                try {
                    dek = await secretKeys.unwrapWithPassword(keyRow, currentPassword);
                } catch (e) {
                    if (e instanceof WrongSecretError) return refuse();
                    throw e;
                }
                const { state } = await secretKeys.prepareWrapWithPassword(dek, newPassword, 'keep', keyRow);
                dek.fill(0);
                await secretKeys.rewrapPasswordAndHash(row.id, state, newHash);
            } else {
                await db.users.updatePasswordHash(row.id, newHash);
            }
            clearAttempts('password', attemptKey);

            // Whoever held the old password is out: every other session, its cached
            // DEK and its socket. This one continues under fresh tokens, same `sid`.
            await db.refreshTokens.revokeUser(row.id);
            forgetSessionsOf(row.id, claims.sid);
            live.closeSessionsOf(row.id, claims.sid);
            await issueSession(reply, db, row.id, claims.sid);

            audit.record({
                source: 'web',
                category: 'auth',
                action: 'password.change',
                level: 'warning',
                uid: row.id,
                ip: req.ip,
                description: `Mot de passe modifié pour « ${row.username} » ; autres sessions fermées`
            });

            return reply.send(ok({ changed: true as const }));
        }
    );
}

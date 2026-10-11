import { changePasswordRequestSchema, err, ok, refreshRequestSchema } from '@deveye/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { clearAttempts, recordFailedAttempt } from '@/Services/attempts';
import type Encryption from '@/Services/Encryption';
import { SecretKeyService, WrongSecretError } from '@/Services/SecretKeyService';
import { forgetSessionDek, forgetSessionsOf } from '@/Services/SecureStore';
import { forgetStepUp, forgetStepUpsOf } from '@/Services/stepUp';
import { hashPassword, verifyPassword } from './argon';
import { clearAuthCookies, REFRESH_COOKIE } from './cookies';
import { authTransport, readAccessToken } from './federation';
import { clearFederationCookie, syncFederationCookie } from './federationCookie';
import { signWsTicket, verifyAccessToken, verifyRefreshToken } from './jwt';
import { markSeen } from './lastSeen';
import { loadUserBundle } from './loadUserBundle';
import { lockedOut } from './lockout';
import { abandonLoginChallengesOf } from './loginChallenge';
import { loginRoutes } from './loginRoutes';
import { issueSession } from './session';

import type { AuditLog } from '@/Services/AuditLog';
import { maintenance, MaintenanceError } from '@/Services/maintenance';
import { isAdminUser } from '@/features/_access';
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

/** Le jeton de rafraîchissement, par le seul canal du transport (voir `readAccessToken`). */
function readRefreshToken(req: FastifyRequest): string | undefined {
    if (authTransport(req) === 'cookie') return req.cookies[REFRESH_COOKIE];
    const parsed = refreshRequestSchema.safeParse(req.body);
    return parsed.success ? parsed.data.refreshToken : undefined;
}

/** Les cookies ne se touchent que pour notre page : une origine fédérée n'en a jamais reçu. */
function dropAuthCookies(req: FastifyRequest, reply: FastifyReply): void {
    if (authTransport(req) === 'cookie') clearAuthCookies(reply);
}

export async function authRoutes(app: FastifyInstance, { db, crypt, audit, live }: AuthDeps): Promise<void> {
    await loginRoutes(app, { db, crypt, audit });

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
        const token = readRefreshToken(req);
        if (!token) return reply.code(401).send(err('auth_required', 'Missing refresh token'));

        const claims = await verifyRefreshToken(token);
        if (!claims) {
            dropAuthCookies(req, reply);
            return reply.code(401).send(err('auth_invalid', 'Invalid refresh token'));
        }

        // Avant la rotation : un refus après elle laisserait le compte sans
        // jeton valide, déconnecté à la fin de la maintenance.
        if (maintenance.siteDown() && !(await isAdminUser(db, Number(claims.sub)))) {
            throw new MaintenanceError(maintenance.message());
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
                forgetStepUp(claims.sid);
                live.closeSession(claims.sid);
                dropAuthCookies(req, reply);
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
            dropAuthCookies(req, reply);
            return reply.code(401).send(err('auth_invalid', 'Unknown user'));
        }

        const { tokens } = await issueSession(reply, db, userId, authTransport(req), claims.sid);
        syncFederationCookie(req, reply, bundle);
        return reply.send(ok({ ...bundle, tokens }));
    });

    app.post('/api/auth/logout', async (req, reply) => {
        const token = readRefreshToken(req);
        if (token) {
            const claims = await verifyRefreshToken(token);
            if (claims) {
                await db.refreshTokens.revokeSession(claims.sid);
                // La socket s'est authentifiée une fois pour toutes : sans la
                // fermer, elle servirait encore le coffre après la déconnexion.
                forgetSessionDek(claims.sid);
                forgetStepUp(claims.sid);
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
        dropAuthCookies(req, reply);
        clearFederationCookie(req, reply);
        return reply.send(ok({ loggedOut: true }));
    });

    app.get('/api/auth/me', async (req, reply) => {
        const accessToken = readAccessToken(req);
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));

        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        // Avant la lecture : sa propre ligne dans la liste des membres dit déjà « aujourd'hui ».
        await markSeen(db, Number(claims.sub));
        const bundle = await loadUserBundle(db, Number(claims.sub), requestedWorkspace(req));
        if (!bundle) return reply.code(401).send(err('auth_invalid', 'Unknown user'));

        syncFederationCookie(req, reply, bundle);
        return reply.send(ok(bundle));
    });

    app.post(
        '/api/auth/change-password',
        { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const accessToken = readAccessToken(req);
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
            forgetStepUpsOf(row.id, claims.sid);
            // Un navigateur de confiance l'était sous l'ancien mot de passe :
            // chacun repassera par les codes, celui-ci compris.
            await db.trustedBrowsers.removeAllOf(row.id);
            abandonLoginChallengesOf(row.id);
            live.closeSessionsOf(row.id, claims.sid);
            const { tokens } = await issueSession(reply, db, row.id, authTransport(req), claims.sid);

            audit.record({
                source: 'web',
                category: 'auth',
                action: 'password.change',
                level: 'warning',
                uid: row.id,
                ip: req.ip,
                description: `Mot de passe modifié pour « ${row.username} » ; autres sessions et navigateurs de confiance oubliés`
            });

            return reply.send(ok({ changed: true as const, tokens }));
        }
    );

    /**
     * Le ticket d'une socket fédérée. Réservé au transport porteur : notre page
     * ouvre la sienne sur son cookie, et n'a aucune raison de faire sortir un
     * droit d'accès dans une URL.
     */
    app.post('/api/auth/ws-ticket', async (req, reply) => {
        if (authTransport(req) !== 'bearer') return reply.code(403).send(err('forbidden', 'Federated origins only'));
        const accessToken = readAccessToken(req);
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));

        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));
        if (!(await db.refreshTokens.hasLiveSession(claims.sid))) {
            return reply.code(401).send(err('auth_invalid', 'Session revoked'));
        }
        if (maintenance.siteDown() && !(await isAdminUser(db, Number(claims.sub)))) {
            throw new MaintenanceError(maintenance.message());
        }
        return reply.send(ok({ ticket: await signWsTicket(Number(claims.sub), claims.sid) }));
    });
}

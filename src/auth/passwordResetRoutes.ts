import {
    err,
    ok,
    passwordResetCompleteRequestSchema,
    passwordResetCompleteResponseSchema,
    passwordResetStartRequestSchema,
    passwordResetVerifyRequestSchema,
    passwordResetVerifyResponseSchema
} from '@deveye/types';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import { LockedOutError, recordFailedAttempt } from '@/Services/attempts';
import type { AuditLog } from '@/Services/AuditLog';
import type { PasswordResetCompleteResult, PasswordResetService } from '@/Services/passwordReset';
import { forgetSessionsOf } from '@/Services/SecureStore';
import { forgetStepUpsOf } from '@/Services/stepUp';
import { lockedOut } from './lockout';
import { abandonLoginChallengesOf } from './loginChallenge';

interface PasswordResetRouteDeps {
    db: Database;
    audit: AuditLog;
    live: LiveHub;
    passwordReset: PasswordResetService;
}

const DEAD_LINK = 'Ce lien est invalide ou a expiré';

const tooMany = (reply: FastifyReply, e: LockedOutError): FastifyReply =>
    reply
        .code(429)
        .header('retry-after', Math.ceil(e.retryAfterMs / 1000))
        .send(err('rate_limited', e.message, { retryAfterMs: e.retryAfterMs }));

export async function passwordResetRoutes(
    app: FastifyInstance,
    { db, audit, live, passwordReset }: PasswordResetRouteDeps
): Promise<void> {
    app.post(
        '/api/auth/password-reset',
        { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = passwordResetStartRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return reply.code(400).send(err('validation', 'Adresse invalide', parsed.error.flatten()));
            }
            // La limite par IP ne protège pas une boîte visée depuis plusieurs
            // adresses : chaque demande compte aussi contre l'adresse demandée.
            const target = parsed.data.email.trim().toLowerCase();
            const locked = lockedOut(reply, 'reset', target);
            if (locked) return locked;
            recordFailedAttempt('reset', target);
            await passwordReset.request(target);
            return reply.send(ok({}));
        }
    );

    app.post(
        '/api/auth/password-reset/verify',
        { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = passwordResetVerifyRequestSchema.safeParse(req.body);
            const opened = parsed.success ? await passwordReset.open(parsed.data.token) : null;
            if (!opened) return reply.code(404).send(err('not_found', DEAD_LINK));
            return reply.send(ok(passwordResetVerifyResponseSchema.parse(opened)));
        }
    );

    app.post(
        '/api/auth/password-reset/complete',
        { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = passwordResetCompleteRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return reply.code(400).send(err('validation', 'Demande invalide', parsed.error.flatten()));
            }
            let result: PasswordResetCompleteResult;
            try {
                result = await passwordReset.complete(parsed.data);
            } catch (e) {
                if (e instanceof LockedOutError) return tooMany(reply, e);
                throw e;
            }
            if (!result.ok) {
                switch (result.reason) {
                    case 'not_found':
                        return reply.code(404).send(err('not_found', DEAD_LINK));
                    case 'recovery_required':
                        return reply.code(400).send(err('validation', 'Le code de récupération est demandé'));
                    case 'wrong_code':
                        audit.record({
                            source: 'web',
                            category: 'auth',
                            action: 'password.reset_failed',
                            level: 'warning',
                            uid: result.userId,
                            ip: req.ip,
                            description: `Réinitialisation refusée pour « ${result.username} » : code de récupération incorrect`
                        });
                        return reply.code(400).send(err('auth_invalid', 'Code de récupération invalide'));
                    case 'impossible':
                        return reply
                            .code(409)
                            .send(
                                err(
                                    'conflict',
                                    'Ce compte n’a plus de code de récupération : son mot de passe ne peut pas être réinitialisé'
                                )
                            );
                }
            }

            const { userId, username, recoveryCode } = result;
            // Qui tenait l'ancien mot de passe sort : toutes les sessions, leurs
            // DEK en mémoire, leurs sockets, et les navigateurs de confiance.
            await db.refreshTokens.revokeUser(userId);
            forgetSessionsOf(userId);
            forgetStepUpsOf(userId);
            await db.trustedBrowsers.removeAllOf(userId);
            abandonLoginChallengesOf(userId);
            live.closeSessionsOf(userId);

            audit.record({
                source: 'web',
                category: 'auth',
                action: 'password.reset',
                level: 'warning',
                uid: userId,
                ip: req.ip,
                description:
                    recoveryCode !== null
                        ? `Mot de passe réinitialisé par mail et code de récupération pour « ${username} » ; sessions fermées`
                        : `Mot de passe réinitialisé par mail pour « ${username} » ; sessions fermées`
            });
            return reply.send(ok(passwordResetCompleteResponseSchema.parse({ username, recoveryCode })));
        }
    );
}

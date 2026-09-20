import {
    err,
    ok,
    signupAvailabilitySchema,
    signupCompleteRequestSchema,
    signupCompleteResponseSchema,
    signupStartRequestSchema,
    signupStartResponseSchema,
    signupStatusSchema,
    signupVerifyRequestSchema,
    signupVerifyResponseSchema
} from '@deveye/types';
import type { FastifyInstance } from 'fastify';

import type { Database } from '@/db';
import { notifyAdmins } from '@/features/admin/notify';
import type { LiveHub } from '@/live/hub';
import { assertAttemptAllowed, LockedOutError, recordFailedAttempt } from '@/Services/attempts';
import type { AuditLog } from '@/Services/AuditLog';
import type { SignupService } from '@/Services/signup';
import { hashPassword } from './argon';
import { loadUserBundle } from './loadUserBundle';
import { issueSession } from './session';

interface SignupRouteDeps {
    db: Database;
    audit: AuditLog;
    live: LiveHub;
    signup: SignupService;
}

const DEAD_LINK = 'Ce lien est invalide ou a expiré';

export async function signupRoutes(app: FastifyInstance, { db, audit, live, signup }: SignupRouteDeps): Promise<void> {
    app.get('/api/auth/signup', { logLevel: 'silent' }, async () =>
        ok(signupAvailabilitySchema.parse({ open: await signup.isOpen() }))
    );

    app.post(
        '/api/auth/signup',
        { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = signupStartRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return reply.code(400).send(err('validation', 'Demande invalide', parsed.error.flatten()));
            }
            const { username, email, plan } = parsed.data;

            // La limite par IP ne protège pas une boîte visée depuis plusieurs
            // adresses : chaque demande compte aussi contre l'adresse demandée.
            const target = email.trim().toLowerCase();
            try {
                assertAttemptAllowed('signup', target);
            } catch (e) {
                if (!(e instanceof LockedOutError)) throw e;
                return reply
                    .code(429)
                    .header('retry-after', Math.ceil(e.retryAfterMs / 1000))
                    .send(err('rate_limited', e.message, { retryAfterMs: e.retryAfterMs }));
            }
            recordFailedAttempt('signup', target);

            const result = await signup.request({ username, email, plan: plan ?? null });
            if (result.ok) return reply.send(ok(signupStartResponseSchema.parse({ watchToken: result.watchToken })));
            if (result.reason === 'closed') {
                return reply.code(403).send(err('forbidden', 'Les inscriptions sont fermées sur ce serveur'));
            }
            if (result.reason === 'username_taken') {
                return reply.code(409).send(err('conflict', 'Ce nom d’utilisateur est déjà pris'));
            }
            return reply.code(502).send(err('internal', 'Le mail de validation n’a pas pu être envoyé'));
        }
    );

    app.get(
        '/api/auth/signup/status',
        { logLevel: 'silent', config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
        async (req, reply) => {
            // En en-tête : une URL finit dans les journaux d'accès, pas lui.
            const watch = req.headers['x-signup-watch'];
            if (typeof watch !== 'string' || watch.length === 0 || watch.length > 128) {
                return reply.code(400).send(err('validation', 'Jeton de suivi manquant'));
            }
            return reply.send(ok(signupStatusSchema.parse({ state: await signup.status(watch) })));
        }
    );

    app.post(
        '/api/auth/signup/verify',
        { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = signupVerifyRequestSchema.safeParse(req.body);
            const opened = parsed.success ? await signup.open(parsed.data.token) : null;
            if (!opened) return reply.code(404).send(err('not_found', DEAD_LINK));
            return reply.send(ok(signupVerifyResponseSchema.parse(opened)));
        }
    );

    app.post(
        '/api/auth/signup/complete',
        { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = signupCompleteRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return reply.code(400).send(err('validation', 'Demande invalide', parsed.error.flatten()));
            }
            const result = await signup.complete(parsed.data.token, await hashPassword(parsed.data.password));
            if (!result.ok) {
                if (result.reason === 'closed') {
                    return reply.code(403).send(err('forbidden', 'Les inscriptions sont fermées sur ce serveur'));
                }
                if (result.reason === 'conflict') {
                    return reply
                        .code(409)
                        .send(err('conflict', 'Ce nom d’utilisateur ou cette adresse vient d’être pris'));
                }
                return reply.code(404).send(err('not_found', DEAD_LINK));
            }

            const { account } = result;
            await issueSession(reply, db, account.userId, 'cookie');
            const bundle = await loadUserBundle(db, account.userId);
            if (!bundle) return reply.code(500).send(err('internal', 'Unable to load user'));
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'signup',
                level: account.role === 'admin' ? 'warning' : 'info',
                uid: account.userId,
                ip: req.ip,
                description:
                    account.role === 'admin'
                        ? `Premier compte du site, administrateur : ${account.username}`
                        : `Nouveau compte créé : ${account.username}`,
                metadata: { email: account.email, plan: account.plan }
            });
            // Né hors de toute commande WS, le compte n'annoncerait rien aux
            // administrateurs sans ce signal.
            await notifyAdmins(db, live, account.personalWorkspaceId, account.userId);
            return reply.send(ok(signupCompleteResponseSchema.parse({ ...bundle, signupPlan: account.plan })));
        }
    );
}

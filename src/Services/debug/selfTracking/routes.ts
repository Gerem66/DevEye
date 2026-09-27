import type { FastifyInstance } from 'fastify';
import { ok } from '@deveye/types';
import { z } from 'zod';

import { ORIGINS } from '@/features/_sdk/context';
import { isDev } from '@/Utils/Env';
import { selfTracking } from './index';

const viewsSchema = z.object({
    views: z
        .array(
            z.object({
                path: z.string().max(120),
                at: z.number().int().optional(),
                referrer: z.string().max(500).optional(),
                language: z.string().max(35).optional(),
                timezone: z.string().max(64).optional(),
                tzOffset: z.number().int().min(-840).max(840).optional(),
                screenWidth: z.number().int().min(0).max(20000).optional()
            })
        )
        .min(1)
        .max(20)
});

/**
 * Les pages que le navigateur a ouvertes, et le crochet des routes
 * d'authentification. À poser avant ces routes : un crochet ajouté après
 * elles ne les verrait pas.
 */
export async function trackingRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/tracking', { logLevel: 'silent' }, async (req) => ok(await selfTracking.stateFor(req)));

    app.post(
        '/api/tracking',
        { logLevel: 'silent', bodyLimit: 8 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
        async (req, reply) => {
            const parsed = viewsSchema.safeParse(req.body);
            // Une page d'ailleurs ne compte pas : `sendBeacon` porte toujours l'Origin.
            if (parsed.success && (isDev || req.headers.origin === ORIGINS.app)) {
                await selfTracking.views(req, parsed.data.views);
            }
            return reply.code(204).send();
        }
    );

    app.addHook('onResponse', async (req, reply) => {
        if (req.url.startsWith('/api/auth/')) await selfTracking.auth(req, reply.statusCode);
    });
}

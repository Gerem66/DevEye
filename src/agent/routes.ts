import { enrollDeviceRequestSchema, enrollDeviceResponseSchema, err, linkCodeResponseSchema, ok } from 'deveye-types';
import type { FastifyInstance } from 'fastify';

import { ACCESS_COOKIE } from '@/auth/cookies';
import { signDeviceToken, verifyAccessToken } from '@/auth/jwt';
import { sha256hex } from '@/Utils/hash';
import { env } from '@/Utils/Env';
import { deviceRowToDevice } from './mappers';
import type { MonitorHub } from './hub';

import type { Database } from '@/db';

interface AgentRouteDeps {
    db: Database;
    hub: MonitorHub;
}

/**
 * HTTP endpoints for the device-linking handshake:
 *  - POST /api/devices/link   (auth user)  → mint a short-lived link code
 *  - POST /api/agent/enroll   (public)     → exchange code for a device token
 */
export async function agentRoutes(app: FastifyInstance, { db, hub }: AgentRouteDeps): Promise<void> {
    app.post('/api/devices/link', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));
        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const { code, expiresAt } = await db.linkCodes.create({
            userId: Number(claims.sub),
            ttlSeconds: env.LINK_CODE_TTL_SECONDS
        });
        return reply.send(ok(linkCodeResponseSchema.parse({ code, expiresAt })));
    });

    app.post('/api/agent/enroll', async (req, reply) => {
        const parsed = enrollDeviceRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid enrollment payload', parsed.error.flatten()));
        }
        const { code, name, fingerprint, platform, publicKey } = parsed.data;

        const consumed = await db.linkCodes.consume(code.trim().toUpperCase());
        if (!consumed) {
            return reply.code(401).send(err('auth_invalid', 'Invalid or expired link code'));
        }
        const ownerId = consumed.userId;

        // Re-enrolling the same machine reuses its device record (new token).
        const existing = await db.devices.findByOwnerFingerprint(ownerId, fingerprint);
        let deviceId: string;
        if (existing) {
            deviceId = existing.id;
        } else {
            const created = await db.devices.create({
                ownerId,
                name,
                fingerprint,
                platform,
                publicKey,
                tokenHash: ''
            });
            deviceId = created.id;
        }

        const deviceToken = await signDeviceToken(deviceId, ownerId);
        await db.devices.setTokenHash(deviceId, sha256hex(deviceToken));

        const row = await db.devices.findById(deviceId);
        if (!row) return reply.code(500).send(err('internal', 'Device not found after enrollment'));

        return reply.send(
            ok(
                enrollDeviceResponseSchema.parse({
                    deviceId,
                    deviceToken,
                    device: deviceRowToDevice(row, hub.isOnline(deviceId))
                })
            )
        );
    });
}

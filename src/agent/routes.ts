import {
    enrollDeviceRequestSchema,
    enrollDeviceResponseSchema,
    err,
    linkCodeRequestSchema,
    linkCodeResponseSchema,
    linkCodesListResponseSchema,
    linkCodeUpdateSchema,
    ok
} from 'deveye-types';
import type { FastifyInstance } from 'fastify';

import { ACCESS_COOKIE } from '@/auth/cookies';
import { signDeviceToken, verifyAccessToken } from '@/auth/jwt';
import { sha256hex } from '@/Utils/hash';
import { env } from '@/Utils/Env';
import type { AuditLog } from '@/Services/AuditLog';
import { deviceRowToDevice } from './mappers';
import type { MonitorHub } from './hub';

import type { Database } from '@/db';

interface AgentRouteDeps {
    db: Database;
    hub: MonitorHub;
    audit: AuditLog;
}

/**
 * HTTP endpoints for the device-linking handshake:
 *  - POST /api/devices/link   (auth user)  → mint a short-lived link code
 *  - POST /api/agent/enroll   (public)     → exchange code for a device token
 */
export async function agentRoutes(app: FastifyInstance, { db, hub, audit }: AgentRouteDeps): Promise<void> {
    app.post('/api/devices/link', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));
        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const parsed = linkCodeRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid link options', parsed.error.flatten()));
        }
        // undefined → server default; null → never expires; number → custom.
        const ttlSeconds = parsed.data.ttlSeconds === undefined ? env.LINK_CODE_TTL_SECONDS : parsed.data.ttlSeconds;

        const created = await db.linkCodes.create({
            userId: Number(claims.sub),
            ttlSeconds,
            autoApprove: parsed.data.autoApprove
        });
        return reply.send(ok(linkCodeResponseSchema.parse(created)));
    });

    // Active (unconsumed, unexpired) link codes — lets the UI show the table of
    // pending codes and re-grab one after the dialog was closed.
    app.get('/api/devices/link-codes', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));
        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const codes = await db.linkCodes.listActive(Number(claims.sub));
        return reply.send(ok(linkCodesListResponseSchema.parse({ codes })));
    });

    // Toggle a still-active code's auto-approval (edited from the codes table).
    app.patch<{ Params: { code: string } }>('/api/devices/link-codes/:code', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));
        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const parsed = linkCodeUpdateSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid update', parsed.error.flatten()));
        }
        const updated = await db.linkCodes.setAutoApprove(
            Number(claims.sub),
            req.params.code.trim().toUpperCase(),
            parsed.data.autoApprove
        );
        if (!updated) return reply.code(404).send(err('not_found', 'Code not found'));
        return reply.send(ok(linkCodeResponseSchema.parse(updated)));
    });

    // Manually invalidate a pending code (e.g. cancel one you no longer need).
    app.delete<{ Params: { code: string } }>('/api/devices/link-codes/:code', async (req, reply) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) return reply.code(401).send(err('auth_required', 'No session'));
        const claims = await verifyAccessToken(accessToken);
        if (!claims) return reply.code(401).send(err('auth_expired', 'Access token expired'));

        const removed = await db.linkCodes.revoke(Number(claims.sub), req.params.code.trim().toUpperCase());
        if (!removed) return reply.code(404).send(err('not_found', 'Code not found'));
        return reply.send(ok({ code: req.params.code }));
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

        // (Re)set the device to a clean enrolled state: pending by default (the
        // owner approves it before its metrics are accepted — defence in depth),
        // or active straight away if the code auto-approves. Doing this for the
        // re-enrollment case too re-pairs a previously archived/revoked machine
        // instead of leaving it stuck (and hidden) in its old state.
        await db.devices.markEnrolled(deviceId, consumed.autoApprove ? 'active' : 'pending');
        audit.record({
            source: 'agent',
            category: 'device',
            action: 'device.enroll',
            level: 'warning',
            uid: ownerId,
            ip: req.ip,
            description: consumed.autoApprove
                ? `Appareil appairé et approuvé automatiquement : « ${name} »`
                : `Appareil appairé (en attente d'approbation) : « ${name} »`,
            metadata: { deviceId, platform, reenrolled: Boolean(existing), autoApprove: consumed.autoApprove }
        });

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

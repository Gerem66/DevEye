import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
    AGENT_TARGETS,
    agentTargetSchema,
    agentTargetsResponseSchema,
    enrollDeviceRequestSchema,
    enrollDeviceResponseSchema,
    err,
    linkCodeRequestSchema,
    linkCodeResponseSchema,
    linkCodesListResponseSchema,
    linkCodeUpdateSchema,
    ok,
    type AgentTarget,
    type DeviceRow
} from 'deveye-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ACCESS_COOKIE } from '@/auth/cookies';
import { signDeviceToken, verifyAccessToken, verifyDeviceToken } from '@/auth/jwt';
import { isAdminUser } from '@/features/_access';
import { sha256hex } from '@/Utils/hash';
import { env } from '@/Utils/Env';
import type { AuditLog } from '@/Services/AuditLog';
import { agentDistDir, readSyncedManifest } from './sync';
import { deviceRowToDevice } from './mappers';
import type { MonitorHub } from './hub';
import type { LiveHub } from '@/live/hub';

import type { Database } from '@/db';

interface AgentRouteDeps {
    db: Database;
    hub: MonitorHub;
    /** Présence en direct : l'appairage d'un appareil change la liste de l'espace. */
    live: LiveHub;
    audit: AuditLog;
}

/** Directory the agent binaries are served from (shared with the reconciler). */
const AGENT_DIST_DIR = agentDistDir();

/**
 * Stream a (validated) target's binary from disk as an octet-stream download.
 * Shared by the admin download and the device-token self-update endpoints.
 */
async function serveBinary(reply: FastifyReply, target: AgentTarget): Promise<FastifyReply> {
    const meta = AGENT_TARGETS.find((t) => t.id === target);
    if (!meta) return reply.code(400).send(err('validation', 'Unknown agent target'));

    const filePath = join(AGENT_DIST_DIR, meta.filename);
    let size: number;
    try {
        const s = await stat(filePath);
        if (!s.isFile()) throw new Error('not a file');
        size = s.size;
    } catch {
        return reply.code(404).send(err('not_found', 'Binaire indisponible pour cette plateforme'));
    }

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', size);
    reply.header('Content-Disposition', `attachment; filename="${meta.filename}"`);
    return reply.send(createReadStream(filePath));
}

/**
 * HTTP endpoints for the device-linking handshake:
 *  - POST /api/devices/link   (auth user)  → mint a short-lived link code
 *  - POST /api/agent/enroll   (public)     → exchange code for a device token
 */
export async function agentRoutes(app: FastifyInstance, { db, hub, live, audit }: AgentRouteDeps): Promise<void> {
    /**
     * Resolve the caller as an admin for the fleet (Appareils) HTTP endpoints.
     * Device pairing, link-code management and agent-binary distribution are
     * reached only from the admin-only Appareils page, so they enforce the admin
     * role server-side too — hiding the menu entry is not a boundary on its own.
     * Returns the admin's user id, or `null` after already sending the 401/403.
     */
    const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<number | null> => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        if (!accessToken) {
            void reply.code(401).send(err('auth_required', 'No session'));
            return null;
        }
        const claims = await verifyAccessToken(accessToken);
        if (!claims) {
            void reply.code(401).send(err('auth_expired', 'Access token expired'));
            return null;
        }
        if (!(await isAdminUser(db, Number(claims.sub)))) {
            void reply.code(403).send(err('forbidden', 'Réservé aux administrateurs'));
            return null;
        }
        return Number(claims.sub);
    };

    app.post('/api/devices/link', async (req, reply) => {
        const userId = await requireAdmin(req, reply);
        if (userId === null) return;

        const parsed = linkCodeRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid link options', parsed.error.flatten()));
        }
        // undefined → server default; null → never expires; number → custom.
        const ttlSeconds = parsed.data.ttlSeconds === undefined ? env.LINK_CODE_TTL_SECONDS : parsed.data.ttlSeconds;

        // L'espace de destination, à défaut celui de l'émetteur. L'appartenance
        // est vérifiée : un code ne peut pas déposer une machine dans un espace
        // que son émetteur ne fréquente pas.
        const issuer = await db.users.findById(userId);
        if (!issuer) return reply.code(401).send(err('auth_invalid', 'Unknown user'));
        const workspaceId = parsed.data.workspaceId ?? issuer.personal_workspace_id;
        if (!(await db.workspaceMembers.isMember(userId, workspaceId))) {
            return reply.code(403).send(err('forbidden', 'Vous n’êtes pas membre de cet espace'));
        }

        const created = await db.linkCodes.create({
            userId,
            workspaceId,
            ttlSeconds,
            autoApprove: parsed.data.autoApprove
        });
        return reply.send(ok(linkCodeResponseSchema.parse(created)));
    });

    // Active (unconsumed, unexpired) link codes — lets the UI show the table of
    // pending codes and re-grab one after the dialog was closed.
    app.get('/api/devices/link-codes', async (req, reply) => {
        const userId = await requireAdmin(req, reply);
        if (userId === null) return;

        const codes = await db.linkCodes.listActive(userId);
        return reply.send(ok(linkCodesListResponseSchema.parse({ codes })));
    });

    // Toggle a still-active code's auto-approval (edited from the codes table).
    app.patch<{ Params: { code: string } }>('/api/devices/link-codes/:code', async (req, reply) => {
        const userId = await requireAdmin(req, reply);
        if (userId === null) return;

        const parsed = linkCodeUpdateSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid update', parsed.error.flatten()));
        }
        const updated = await db.linkCodes.setAutoApprove(
            userId,
            req.params.code.trim().toUpperCase(),
            parsed.data.autoApprove
        );
        if (!updated) return reply.code(404).send(err('not_found', 'Code not found'));
        return reply.send(ok(linkCodeResponseSchema.parse(updated)));
    });

    // Manually invalidate a pending code (e.g. cancel one you no longer need).
    app.delete<{ Params: { code: string } }>('/api/devices/link-codes/:code', async (req, reply) => {
        const userId = await requireAdmin(req, reply);
        if (userId === null) return;

        const removed = await db.linkCodes.revoke(userId, req.params.code.trim().toUpperCase());
        if (!removed) return reply.code(404).send(err('not_found', 'Code not found'));
        return reply.send(ok({ code: req.params.code }));
    });

    // Availability of each shippable agent binary, so the UI can grey out the
    // targets whose file isn't present (e.g. a dev box that only built its own).
    app.get('/api/agent/targets', async (req, reply) => {
        if ((await requireAdmin(req, reply)) === null) return;

        const targets = await Promise.all(
            AGENT_TARGETS.map(async (t) => {
                let sizeBytes: number | null = null;
                try {
                    const s = await stat(join(AGENT_DIST_DIR, t.filename));
                    if (s.isFile()) sizeBytes = s.size;
                } catch {
                    // Missing/unreadable → unavailable.
                }
                return { id: t.id, os: t.os, label: t.label, available: sizeBytes !== null, sizeBytes };
            })
        );
        // Version of the synced set (local manifest read — no GitHub at runtime).
        const manifest = await readSyncedManifest(AGENT_DIST_DIR);
        return reply.send(ok(agentTargetsResponseSchema.parse({ agentVersion: manifest?.version ?? null, targets })));
    });

    // Stream a prebuilt agent binary as a download. Admin-only like the rest of
    // the Appareils page (binaries aren't secret, but no non-admin enumeration).
    app.get<{ Params: { target: string } }>('/api/agent/download/:target', async (req, reply) => {
        if ((await requireAdmin(req, reply)) === null) return;

        const parsed = agentTargetSchema.safeParse(req.params.target);
        if (!parsed.success) return reply.code(400).send(err('validation', 'Unknown agent target'));
        return serveBinary(reply, parsed.data);
    });

    /**
     * Authenticate the caller as an enrolled device via its device token (Bearer
     * header or `?token=`), mirroring the `/agent` WS auth. Used by the self-update
     * download — the agent isn't an admin, it presents its own token. Returns the
     * device row, or `null` after already sending the 401/403.
     */
    const authDevice = async (req: FastifyRequest, reply: FastifyReply): Promise<DeviceRow | null> => {
        const authHeader = req.headers['authorization'];
        let token: string | null = null;
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
        else {
            const q = req.query as { token?: unknown } | undefined;
            if (q && typeof q.token === 'string') token = q.token;
        }
        if (!token) {
            void reply.code(401).send(err('auth_required', 'No device token'));
            return null;
        }
        const claims = await verifyDeviceToken(token);
        const device = claims ? await db.devices.findById(claims.sub) : null;
        if (!device || device.token_hash !== sha256hex(token)) {
            void reply.code(401).send(err('auth_invalid', 'Invalid device token'));
            return null;
        }
        if (device.status === 'revoked' || device.status === 'archived') {
            void reply.code(403).send(err('forbidden', 'Device not allowed'));
            return null;
        }
        return device;
    };

    // Device-token download for the self-update flow: an authenticated agent pulls
    // the binary for its OWN reported build target. Distinct from the admin
    // `/download` above (cookie auth, any target). The `agent.update` order tells
    // the agent which target + sha256 + signature to expect.
    app.get<{ Params: { target: string } }>('/api/agent/self-update/:target', async (req, reply) => {
        const device = await authDevice(req, reply);
        if (!device) return;

        const parsed = agentTargetSchema.safeParse(req.params.target);
        if (!parsed.success) return reply.code(400).send(err('validation', 'Unknown agent target'));
        // An agent may only fetch the binary matching the target it reported.
        if (device.agent_target && device.agent_target !== parsed.data) {
            return reply.code(403).send(err('forbidden', 'Target mismatch'));
        }
        return serveBinary(reply, parsed.data);
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
        const workspaceId = consumed.workspaceId;

        // Re-enrolling the same machine reuses its device record (new token).
        // L'unicité se mesure par espace : la même machine peut être appairée
        // une fois dans chacun.
        const existing = await db.devices.findByWorkspaceFingerprint(workspaceId, fingerprint);
        let deviceId: string;
        if (existing) {
            deviceId = existing.id;
        } else {
            const created = await db.devices.create({
                ownerId,
                workspaceId,
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
        // Un appareil vient d'entrer dans l'espace, et son code d'appairage de
        // disparaître : c'est ce qui remplace le sondage du dialogue « Lier un
        // appareil ». L'appairage passe par cette route HTTP, pas par une
        // commande WS — sans ce signal, rien n'en avertirait personne.
        live.changed(workspaceId, ['devices'], null);
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

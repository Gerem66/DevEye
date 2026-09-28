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
    ok,
    type AgentTarget,
    type DeviceRow
} from '@deveye/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { readAccessToken } from '@/auth/federation';
import { signDeviceToken, verifyAccessToken } from '@/auth/jwt';
import { holdsFeatureIn } from '@/features/_access';
import { sha256hex } from '@/Utils/hash';
import { authenticateDevice, deviceTokenOf } from './deviceAuth';
import { readInstaller, renderInstaller } from './installers';
import { orderSigningPublicKey } from './orders';
import type { AuditLog } from '@/Services/AuditLog';
import { agentDistDir, readSyncedManifest } from './sync';
import { metricIntervalOf } from './cadence';
import { deviceRowToDevice } from './mappers';
import type { MonitorHub } from './hub';
import type { LiveHub } from '@/live/hub';

import type { Database } from '@/db';
import { ORIGINS } from '@/features/_sdk/context';
import { moduleProvider } from '@/features/_sdk/register';
import { assertAttemptAllowed, LockedOutError, recordFailedAttempt } from '@/Services/attempts';
import { schedulePlanReconcile } from '@/Services/planPauses';
import { limitIn, ownedWorkspaceIds, planOf } from '@/Services/quota';

/** La clé que le module Appareils déclare (`manifest.quotas`). */
const AGENTS_QUOTA = 'devices.agents';

/** Si l'offre du propriétaire de l'espace admet un appareil de plus, et qui est ce propriétaire. */
async function agentQuota(
    db: Database,
    workspaceId: number,
    logger: { error(obj: object, msg: string): void }
): Promise<{ allowed: boolean; ownerUserId: number | null }> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) return { allowed: true, ownerUserId: null };
    const ownerUserId = workspace.owner_user_id;
    const plan = await planOf({ get: <T>(key: string) => moduleProvider<T>(key) }, ownerUserId, logger);
    const limit = limitIn(plan, AGENTS_QUOTA);
    if (limit === null) return { allowed: true, ownerUserId };
    const owned = await ownedWorkspaceIds(db, ownerUserId);
    return { allowed: (await db.devices.countActiveInWorkspaces(owned)) + 1 <= limit, ownerUserId };
}

const INVALID_CODE = 'Invalid or expired link code';

/** Écrit pour la personne au clavier : l'agent l'affiche tel quel. */
const KNOWN_MACHINE =
    'Cette machine est déjà appairée dans l’espace. Une copie d’une même image ? Reliez-la avec --shuffle-id. Pour la réappairer, générez un code à usage unique.';

function isDuplicate(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

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
 * Les routes HTTP de l'infrastructure des agents : l'enrôlement (public, échange
 * un code de liaison contre un jeton d'appareil) et la distribution des binaires
 * (le droit d'appairer dans l'espace visé, ou un jeton d'appareil pour
 * l'auto-mise à jour). L'émission des codes de liaison est une commande du
 * module `features/devices`.
 */
export async function agentRoutes(app: FastifyInstance, { db, hub, live, audit }: AgentRouteDeps): Promise<void> {
    /**
     * Le droit d'appairer dans l'espace visé (`?workspace=`), le même que celui
     * qui émet un code de liaison : télécharger un binaire n'a de sens que pour
     * y brancher une machine. La garde est ici et pas seulement à l'écran.
     * Rend `false` après avoir déjà répondu 400/401/403.
     */
    const requirePairing = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
        const accessToken = readAccessToken(req);
        if (!accessToken) {
            void reply.code(401).send(err('auth_required', 'No session'));
            return false;
        }
        const claims = await verifyAccessToken(accessToken);
        if (!claims) {
            void reply.code(401).send(err('auth_expired', 'Access token expired'));
            return false;
        }
        const workspaceId = Number((req.query as { workspace?: string }).workspace);
        if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
            void reply.code(400).send(err('validation', 'Espace manquant'));
            return false;
        }
        if (!(await holdsFeatureIn(db, Number(claims.sub), workspaceId, 'devices', 'write'))) {
            void reply.code(403).send(err('forbidden', 'Vous ne gérez pas les appareils de cet espace'));
            return false;
        }
        return true;
    };

    /**
     * Tout ce qui présente un code de liaison (l'enrôlement, le téléchargement du
     * script d'installation) : verrouillage de l'adresse sur les échecs, code
     * encore valable, émetteur qui gère toujours les appareils de l'espace. Un
     * succès n'efface pas l'ardoise : qui tient un code valable ne doit pas s'en
     * servir pour remettre ses essais à zéro. Rend `null` après avoir répondu.
     */
    const linkCodeGate = async (
        req: FastifyRequest,
        reply: FastifyReply,
        raw: string
    ): Promise<{ code: string; userId: number; workspaceId: number; maxUses: number } | null> => {
        try {
            assertAttemptAllowed('linkcode', req.ip);
        } catch (e) {
            if (!(e instanceof LockedOutError)) throw e;
            void reply
                .code(429)
                .header('Retry-After', Math.ceil(e.retryAfterMs / 1000))
                .send(err('rate_limited', e.message, { retryAfterMs: e.retryAfterMs }));
            return null;
        }
        const code = raw.trim().toUpperCase();
        const peeked = code ? await db.linkCodes.peek(code) : null;
        const issuerStillManages =
            peeked !== null && (await holdsFeatureIn(db, peeked.userId, peeked.workspaceId, 'devices', 'write'));
        if (!peeked || !issuerStillManages) {
            recordFailedAttempt('linkcode', req.ip);
            void reply.code(401).send(err('auth_invalid', INVALID_CODE));
            return null;
        }
        return { code, ...peeked };
    };

    // Availability of each shippable agent binary, so the UI can grey out the
    // targets whose file isn't present (e.g. a dev box that only built its own).
    app.get('/api/agent/targets', async (req, reply) => {
        if (!(await requirePairing(req, reply))) return;

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

    // Stream a prebuilt agent binary as a download. Gated like the pairing it
    // serves (binaries aren't secret, but no enumeration by a passer-by).
    app.get<{ Params: { target: string } }>('/api/agent/download/:target', async (req, reply) => {
        if (!(await requirePairing(req, reply))) return;

        const parsed = agentTargetSchema.safeParse(req.params.target);
        if (!parsed.success) return reply.code(400).send(err('validation', 'Unknown agent target'));
        return serveBinary(reply, parsed.data);
    });

    /**
     * Authenticate the caller as an enrolled device via its device token, by the
     * same rule as the `/agent` WS (`deviceAuth.ts`). Used by the self-update
     * download — the agent isn't an admin, it presents its own token. Returns the
     * device row, or `null` after already sending the 401/403.
     */
    const authDevice = async (req: FastifyRequest, reply: FastifyReply): Promise<DeviceRow | null> => {
        const presented = deviceTokenOf(req);
        if (!presented) {
            void reply.code(401).send(err('auth_required', 'No device token'));
            return null;
        }
        const authenticated = await authenticateDevice(db, presented.token);
        if (!authenticated) {
            void reply.code(401).send(err('auth_invalid', 'Invalid device token'));
            return null;
        }
        const { device } = authenticated;
        // Ce que la socket n'admet pas ne télécharge rien non plus.
        if (device.status !== 'active') {
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

    // Le binaire du script d'installation, qui n'a pas de session : le code de
    // liaison en tient lieu, sans qu'un usage en soit dépensé. Il voyage dans un
    // en-tête, jamais dans l'URL, que les journaux d'accès gardent.
    app.get<{ Params: { target: string } }>(
        '/api/agent/install/:target',
        { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = agentTargetSchema.safeParse(req.params.target);
            if (!parsed.success) return reply.code(400).send(err('validation', 'Unknown agent target'));
            const header = req.headers['x-deveye-link-code'];
            if (!(await linkCodeGate(req, reply, typeof header === 'string' ? header : ''))) return reply;
            return serveBinary(reply, parsed.data);
        }
    );

    // Les scripts d'installation, hors de `/api` pour une commande qui se lit
    // (`curl …/install.sh | sh`). Rendus une fois : l'origine ne change pas en
    // cours de route. Les domaines des clients passent par `publicApp.ts`, qui
    // ne les sert pas.
    for (const kind of ['sh', 'ps1'] as const) {
        const script = renderInstaller(readInstaller(kind), ORIGINS.app);
        if (script === null) {
            app.log.error({ origin: ORIGINS.app }, `PUBLIC_ORIGIN impropre à un script : /install.${kind} désactivé`);
        }
        app.get(`/install.${kind}`, async (_req, reply) => {
            if (script === null) return reply.code(500).send(err('internal', 'Installer unavailable'));
            // Sans jeu de caractères, Windows PowerShell 5.1 lit le script en Latin-1.
            return reply.type('text/plain; charset=utf-8').header('Cache-Control', 'no-cache').send(script);
        });
    }

    // Route publique qui consomme un secret : la deviner tient au nombre
    // d'essais, que `linkCodeGate` borne par adresse. La limite de débit laisse
    // passer une flotte entière derrière un seul NAT.
    app.post(
        '/api/agent/enroll',
        { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const parsed = enrollDeviceRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return reply.code(400).send(err('validation', 'Invalid enrollment payload', parsed.error.flatten()));
            }
            const { name, fingerprint, platform } = parsed.data;
            const gated = await linkCodeGate(req, reply, parsed.data.code);
            if (!gated) return reply;
            const { code, userId: ownerId, workspaceId, maxUses } = gated;

            // L'unicité se mesure par espace : la même machine peut être appairée
            // une fois dans chacun.
            const existing = await db.devices.findByWorkspaceFingerprint(workspaceId, fingerprint);
            // Un code qui sert plusieurs machines ne reprend jamais la fiche d'une
            // machine connue : deux clones d'une même image se la voleraient en
            // silence. Réappairer reste un geste délibéré, à usage unique.
            if (existing && maxUses > 1) return reply.code(409).send(err('conflict', KNOWN_MACHINE));
            // Une machine neuve prend une place de l'offre, vérifiée avant de
            // dépenser un usage : un refus ne doit pas le brûler.
            let quotaOwner: number | null = null;
            if (!existing) {
                const quota = await agentQuota(db, workspaceId, app.log);
                if (!quota.allowed) {
                    return reply
                        .code(403)
                        .send(
                            err(
                                'quota_exceeded',
                                'Limite d’appareils de l’offre atteinte : libérez une place dans DevEye ou changez d’offre. Le code de liaison reste valable.',
                                { key: 'devices.agents' }
                            )
                        );
                }
                quotaOwner = quota.ownerUserId;
            }

            let enrolled: { deviceId: string; deviceToken: string } | null;
            try {
                enrolled = await db.transaction(async (tx) => {
                    if (!(await tx.linkCodes.consume(code))) return null;
                    const deviceId = existing
                        ? existing.id
                        : (
                              await tx.devices.create({
                                  ownerId,
                                  workspaceId,
                                  name,
                                  fingerprint,
                                  platform,
                                  status: 'active',
                                  tokenHash: ''
                              })
                          ).id;
                    const deviceToken = await signDeviceToken(deviceId, ownerId);
                    // L'ancien jeton d'une machine réappairée tombe avec : pas de condensé précédent.
                    await tx.devices.setTokenHashes(deviceId, sha256hex(deviceToken), null);
                    // L'empreinte est déclarée par l'appelant : un réappairage reprend
                    // la fiche d'une machine (son historique, ses partages), donc il
                    // attend toujours une approbation.
                    if (existing) await tx.devices.markEnrolled(deviceId, 'pending');
                    return { deviceId, deviceToken };
                });
            } catch (e) {
                // Deux machines à la même empreinte, enrôlées au même instant.
                if (isDuplicate(e)) return reply.code(409).send(err('conflict', KNOWN_MACHINE));
                throw e;
            }
            if (!enrolled) return reply.code(401).send(err('auth_invalid', INVALID_CODE));
            const { deviceId, deviceToken } = enrolled;

            // La session ouverte sous l'ancien jeton tombe avec lui.
            if (existing) hub.disconnectAgent(deviceId);
            // Des enrôlements simultanés passent tous la vérification de l'offre :
            // la passe des pauses tient les surnuméraires, les plus récents d'abord.
            if (quotaOwner !== null) schedulePlanReconcile(quotaOwner);
            // L'appairage passe par cette route HTTP, pas par une commande WS :
            // sans ce signal, rien n'avertirait l'espace.
            live.changed(workspaceId, ['devices'], null);
            audit.record({
                source: 'agent',
                category: 'device',
                action: 'device.enroll',
                level: existing ? 'critical' : 'warning',
                uid: ownerId,
                ip: req.ip,
                description: existing
                    ? `Réappairage d'un appareil existant, son ancien jeton est invalidé (en attente d'approbation) : « ${existing.name} »`
                    : `Appareil appairé et actif : « ${name} »`,
                metadata: { deviceId, platform, reenrolled: Boolean(existing), maxUses }
            });

            const row = await db.devices.findById(deviceId);
            if (!row) return reply.code(500).send(err('internal', 'Device not found after enrollment'));

            return reply.send(
                ok(
                    enrollDeviceResponseSchema.parse({
                        deviceId,
                        deviceToken,
                        orderSigningKey: orderSigningPublicKey,
                        device: deviceRowToDevice(row, await metricIntervalOf(db, row), hub.isOnline(deviceId))
                    })
                )
            );
        }
    );
}

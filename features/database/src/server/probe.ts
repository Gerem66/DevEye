import { databaseInspect, databaseQuery, databaseTest, databaseTestDraft } from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { authorizeDevice, relayOf } from './device';
import { explainError, openSession, type Session } from './engine';
import { loadDatabase, monitorOf, reloadDatabase, type Ctx } from './_shared';

/**
 * Ce qui joint réellement un serveur, toujours sur un geste explicite. Sous le
 * droit d'écriture : lire une base, même en `SELECT`, consomme une connexion
 * chez un tiers et expose son contenu.
 */

/** Ouvre une session vers une base visible, cible déchiffrée sous la clé de son domicile. */
async function sessionFor(ctx: Ctx, databaseId: number): Promise<Session> {
    const row = await loadDatabase(ctx, databaseId);
    await ctx.quota.assertActive('connections', String(databaseId));
    const monitor = monitorOf();
    try {
        return await openSession(await monitor.targetOf(row, row.workspace_id));
    } catch (e) {
        // Un serveur injoignable est une réponse attendue, pas un `internal`.
        throw new FeatureError('conflict', explainError(e));
    }
}

/** Ouvre, fait, referme : le `finally` empêche les tunnels de fuir. */
export async function withSession<T>(ctx: Ctx, databaseId: number, run: (s: Session) => Promise<T>): Promise<T> {
    const session = await sessionFor(ctx, databaseId);
    try {
        return await run(session);
    } catch (e) {
        if (e instanceof FeatureError) throw e;
        throw new FeatureError('conflict', explainError(e));
    } finally {
        try {
            await session.close();
        } catch {
            /* la fermeture d'une session déjà morte n'a rien à dire */
        }
    }
}

export const databaseProbeFeatures = [
    defineSdkFeature({
        ...databaseTest,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            await loadDatabase(ctx, input.databaseId);
            // Avant l'essai, qui rend tout échec comme un résultat : la pause doit lever.
            await ctx.quota.assertActive('connections', String(input.databaseId));
            const started = Date.now();
            // Ne lève jamais : un échec de connexion est le résultat normal d'un test.
            try {
                const version = await withSession(ctx, input.databaseId, (s) => s.serverVersion());
                return { probe: { ok: true, serverVersion: version, elapsedMs: Date.now() - started, error: null } };
            } catch (e) {
                const message = e instanceof FeatureError ? e.message : explainError(e);
                return { probe: { ok: false, serverVersion: null, elapsedMs: Date.now() - started, error: message } };
            }
        }
    }),
    /** Le même essai sur des réglages pas encore enregistrés ; n'écrit rien. */
    defineSdkFeature({
        ...databaseTestDraft,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            const cipher = ctx.cipher();
            let password = input.password ?? null;
            let accessSecret = input.access.secret ?? null;

            // Champ laissé intact : le secret enregistré prend le relais, lu sur
            // la base visée que `loadDatabase` borne à l'espace ; on ne peut pas
            // essayer le mot de passe d'autrui sur son propre hôte.
            if (input.databaseId !== undefined && (input.password === undefined || input.access.secret === undefined)) {
                const row = await loadDatabase(ctx, input.databaseId);
                if (input.password === undefined) {
                    password = row.secret_enc ? await cipher.tryDecrypt(row.secret_enc) : null;
                }
                if (input.access.secret === undefined) {
                    accessSecret = row.access_secret_enc ? await cipher.tryDecrypt(row.access_secret_enc) : null;
                }
            }

            // Un refus de droit lève, comme à l'enregistrement : ce n'est pas
            // un échec de connexion.
            const device = input.access.kind === 'device' ? await authorizeDevice(ctx, input.access.deviceId) : null;

            const started = Date.now();
            let session: Session | null = null;
            try {
                const relay = device
                    ? relayOf(ctx.deveye.agents, device, ctx.deveye.devices.isOnline(device.id))
                    : null;
                session = await openSession({
                    engine: input.engine,
                    host: input.host,
                    port: input.port,
                    database: input.database,
                    username: input.username,
                    password,
                    access: { ...input.access, secret: accessSecret, relay }
                });
                const version = await session.serverVersion();
                return { probe: { ok: true, serverVersion: version, elapsedMs: Date.now() - started, error: null } };
            } catch (e) {
                return {
                    probe: { ok: false, serverVersion: null, elapsedMs: Date.now() - started, error: explainError(e) }
                };
            } finally {
                try {
                    await session?.close();
                } catch {
                    /* la fermeture d'une session déjà morte n'a rien à dire */
                }
            }
        }
    }),
    /** Le même chemin que l'ordonnanceur (`DatabaseMonitor.checkNow`), notifications comprises. */
    defineSdkFeature({
        ...databaseInspect,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadDatabase(ctx, input.databaseId);
            await ctx.quota.assertActive('connections', String(input.databaseId));
            // Le relevé lit la base chez elle et diffuse à son espace.
            const probe = await monitorOf().checkNow(input.databaseId, row.workspace_id);
            return { database: await reloadDatabase(ctx, input.databaseId), probe };
        }
    }),
    defineSdkFeature({
        ...databaseQuery,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => ({
            // `session.query` refuse tout ce qui n'est pas une lecture unique.
            rows: await withSession(ctx, input.databaseId, (s) => s.query(input.sql))
        })
    })
];

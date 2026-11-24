import {
    databaseAdd,
    databaseCount,
    databaseDevices,
    databaseGet,
    databaseList,
    databaseRemove,
    databaseReorder,
    databaseSetTier,
    databaseUpdate
} from '../contracts/commands';
import { authorizeRelayDevice, defineSdkFeature, FeatureError, relayDeviceOptions } from '@deveye/types/sdk/server';

import {
    assertSecretsStay,
    assertTierAllowed,
    databaseCipherFor,
    GUARDED_IDLE,
    loadDatabase,
    nameRef,
    projectCountsOf,
    projectUsageOf,
    reloadDatabase,
    secretsCipherFor,
    toAlert,
    toDatabase,
    toKpis,
    type Ctx,
    type StoredAccess,
    type StoredDatabase
} from './_shared';

/**
 * Les bases de l'espace : inventaire, réglages, suppression, ordre. Rien ici ne
 * joint un serveur ; `probe.ts` s'en charge, sur demande.
 */

/**
 * Ce que le client envoie pour décrire un accès, sans son secret. Par un
 * appareil, l'appelant doit pouvoir en ouvrir le réseau, et il en devient
 * l'auteur : le relevé cesse quand il perd ce droit.
 */
async function accessBody(
    ctx: Ctx,
    input: {
        kind: StoredAccess['kind'];
        host: string;
        port: number | null;
        username: string;
        auth: StoredAccess['auth'];
        deviceId: string | null;
    }
): Promise<StoredAccess> {
    const device = input.kind === 'device' ? await authorizeRelayDevice(ctx, input.deviceId, 'cette base') : null;
    return {
        kind: input.kind,
        host: input.host.trim(),
        port: input.port,
        username: input.username.trim(),
        auth: input.auth,
        deviceId: device?.id ?? null,
        authorUserId: device ? ctx.userId : null
    };
}

export const databaseCrudFeatures = [
    defineSdkFeature({
        ...databaseCount,
        handler: async (ctx: Ctx) => {
            // Les mêmes lignes que la liste, restrictions déduites.
            const rows = await ctx.repo.listVisible(ctx.workspaceId);
            const hidden = await ctx.items.restrictions();
            return { count: rows.filter((r) => hidden.get(String(r.id)) !== 'none').length };
        }
    }),
    defineSdkFeature({
        ...databaseList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.listVisible(ctx.workspaceId);
            // Une base masquée pour ce rôle disparaît de la liste plutôt que d'y
            // figurer grisée : la voir apprendrait déjà qu'elle existe.
            const hidden = await ctx.items.restrictions();
            const visible = rows.filter((r) => hidden.get(String(r.id)) !== 'none');
            const [scope, counts] = await Promise.all([ctx.sharing.scope(), projectCountsOf(ctx)]);
            return {
                databases: await Promise.all(
                    visible.map(async (row) =>
                        toDatabase(
                            await scope.cipherFor(String(row.id)),
                            row,
                            row.workspace_id !== ctx.workspaceId,
                            counts.get(row.id) ?? 0,
                            ctx.quota.isPaused('connections', String(row.id))
                        )
                    )
                )
            };
        }
    }),
    defineSdkFeature({
        ...databaseGet,
        handler: async (ctx: Ctx, input) => {
            // Visible, pas seulement locale : la fiche d'une base projetée s'ouvre
            // depuis la fenêtre.
            const row = await ctx.repo.findVisibleWithStats(input.databaseId, ctx.workspaceId);
            if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
            await ctx.items.assert(String(input.databaseId));
            // La base est chiffrée chez elle ; les projets liés sont ceux d'ici,
            // via le contrat de Projets.
            const homeCipher = await databaseCipherFor(ctx, row);
            const [usage, counts, alertRows] = await Promise.all([
                projectUsageOf(ctx, input.databaseId),
                projectCountsOf(ctx),
                ctx.repo.listAlerts(input.databaseId, row.workspace_id)
            ]);
            return {
                database: await toDatabase(
                    homeCipher,
                    row,
                    row.workspace_id !== ctx.workspaceId,
                    counts.get(input.databaseId) ?? 0,
                    ctx.quota.isPaused('connections', String(input.databaseId))
                ),
                usage,
                alerts: await Promise.all(alertRows.map((a) => toAlert(homeCipher, a))),
                kpis: await toKpis(homeCipher, row)
            };
        }
    }),
    defineSdkFeature({
        ...databaseAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const cipher = ctx.cipher();
            const ref = nameRef(ctx.keys, ctx.workspaceId, input.name);

            await assertTierAllowed(ctx, input.securityTier);
            if (input.securityTier === 'guarded' && input.monitorEnabled) {
                throw new FeatureError('validation', GUARDED_IDLE);
            }
            // Le nom porte l'unicité dans l'espace.
            if (await ctx.repo.findByName(ctx.workspaceId, ref)) {
                throw new FeatureError('conflict', 'Une base porte déjà ce nom dans cet espace.');
            }
            await ctx.quota.assert('connections', async (owned) => (await ctx.repo.countInWorkspaces(owned)) + 1);

            const body: StoredDatabase = {
                name: input.name.trim(),
                host: input.host.trim(),
                port: input.port,
                database: input.database.trim(),
                username: input.username.trim(),
                ...(input.autoLoadTables ? {} : { tablesOnDemand: true as const })
            };

            // Les secrets naissent sous la clé de leur étage : ceux d'une base
            // protégée ne passent jamais sous celle que le serveur ouvre seul.
            const secrets = await secretsCipherFor(ctx, {
                id: 0,
                workspace_id: ctx.workspaceId,
                security_tier: input.securityTier
            });
            const row = await ctx.repo.create({
                workspaceId: ctx.workspaceId,
                engine: input.engine,
                nameRef: ref,
                content: await cipher.encrypt(JSON.stringify(body)),
                secretEnc: input.password ? await secrets.encrypt(input.password) : null,
                accessContent: await cipher.encrypt(JSON.stringify(await accessBody(ctx, input.access))),
                accessSecretEnc: input.access.secret ? await secrets.encrypt(input.access.secret) : null,
                securityTier: input.securityTier,
                monitorEnabled: input.monitorEnabled,
                intervalSeconds: input.intervalSeconds
            });

            ctx.audit({
                action: 'database.add',
                description: 'Base de données ajoutée à l’espace',
                metadata: { databaseId: row.id, engine: input.engine, securityTier: input.securityTier }
            });
            return { database: await reloadDatabase(ctx, row.id) };
        }
    }),
    defineSdkFeature({
        ...databaseUpdate,
        access: { level: 'write', item: 'databaseId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Domicile seulement : la ligne serait réécrite sous la clé d'ici,
            // illisible chez elle.
            const home = await loadDatabase(ctx, input.databaseId, 'write');
            if (home.workspace_id !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Cette base appartient à un autre espace : elle se modifie et se supprime depuis là-bas.'
                );
            }
            const cipher = ctx.cipher();
            const ref = nameRef(ctx.keys, ctx.workspaceId, input.name);
            if (home.security_tier === 'guarded' && input.monitorEnabled) {
                throw new FeatureError('validation', GUARDED_IDLE);
            }
            // Un secret ressaisi s'écrit sous la clé de l'étage de la base.
            const resealed = input.password !== undefined || input.access.secret !== undefined;
            const secrets = resealed ? await secretsCipherFor(ctx, home) : cipher;

            const clash = await ctx.repo.findByName(ctx.workspaceId, ref);
            if (clash && clash.id !== input.databaseId) {
                throw new FeatureError('conflict', 'Une autre base porte déjà ce nom dans cet espace.');
            }

            const body: StoredDatabase = {
                name: input.name.trim(),
                host: input.host.trim(),
                port: input.port,
                database: input.database.trim(),
                username: input.username.trim(),
                ...(input.autoLoadTables ? {} : { tablesOnDemand: true as const })
            };

            // Secret absent = inchangé, chaîne vide = effacé. Le client ne le reçoit
            // jamais, il ne peut donc pas le renvoyer tel quel.
            const access = await accessBody(ctx, input.access);
            await assertSecretsStay(
                cipher,
                home,
                { engine: home.engine, ...body, access },
                { password: input.password === undefined, accessSecret: input.access.secret === undefined }
            );
            const row = await ctx.repo.update(input.databaseId, ctx.workspaceId, {
                nameRef: ref,
                content: await cipher.encrypt(JSON.stringify(body)),
                secretEnc:
                    input.password === undefined
                        ? undefined
                        : input.password
                          ? await secrets.encrypt(input.password)
                          : null,
                accessContent: await cipher.encrypt(JSON.stringify(access)),
                accessSecretEnc:
                    input.access.secret === undefined
                        ? undefined
                        : input.access.secret
                          ? await secrets.encrypt(input.access.secret)
                          : null,
                monitorEnabled: input.monitorEnabled,
                intervalSeconds: input.intervalSeconds
            });
            if (!row) throw new FeatureError('not_found', 'Base de données introuvable');
            return { database: await reloadDatabase(ctx, input.databaseId) };
        }
    }),
    defineSdkFeature({
        ...databaseSetTier,
        access: { level: 'write', item: 'databaseId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const home = await loadDatabase(ctx, input.databaseId, 'write');
            if (home.workspace_id !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Cette base appartient à un autre espace : sa protection se règle depuis là-bas.'
                );
            }
            if (home.security_tier === input.securityTier) return { database: await reloadDatabase(ctx, home.id) };
            await assertTierAllowed(ctx, input.securityTier);

            // Lus sous la clé qu'on quitte, récrits sous celle où l'on va : dans
            // les deux sens, la session doit tenir la clé du mot de passe.
            const from = await secretsCipherFor(ctx, home);
            const to = await secretsCipherFor(ctx, { ...home, security_tier: input.securityTier });
            const reseal = async (blob: string | null): Promise<string | null> => {
                if (!blob) return blob;
                const plain = await from.tryDecrypt(blob);
                if (plain === null) {
                    throw new FeatureError(
                        'conflict',
                        'Un secret de cette base ne se relit plus : ressaisissez-le dans ses réglages avant de changer sa protection.'
                    );
                }
                return to.encrypt(plain);
            };
            const changed = await ctx.repo.setTier(home.id, ctx.workspaceId, {
                securityTier: input.securityTier,
                secretEnc: await reseal(home.secret_enc),
                accessSecretEnc: await reseal(home.access_secret_enc)
            });
            if (!changed) throw new FeatureError('not_found', 'Base de données introuvable');
            ctx.audit({
                action: 'database.tier',
                description:
                    input.securityTier === 'guarded'
                        ? 'Base de données protégée par mot de passe'
                        : 'Base de données rouverte au serveur',
                metadata: { databaseId: home.id, securityTier: input.securityTier }
            });
            return { database: await reloadDatabase(ctx, home.id) };
        }
    }),
    defineSdkFeature({
        ...databaseRemove,
        access: { level: 'write', item: 'databaseId' },
        // Le sujet `projects` n'est pas nommable par un module : le tableau et
        // les compteurs d'un projet se remettent à jour à leur prochaine lecture.
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const ok = await ctx.repo.remove(input.databaseId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Base de données introuvable');
            // Projections, restrictions et route de notification ne tiennent à
            // aucune clé étrangère : sans ce ménage, elles s'appliqueraient à la
            // prochaine base à hériter de l'identifiant.
            await ctx.items.forget(String(input.databaseId));
            ctx.audit({
                action: 'database.remove',
                description: 'Base de données retirée de l’espace',
                metadata: { databaseId: input.databaseId }
            });
            return { databaseId: input.databaseId };
        }
    }),
    defineSdkFeature({
        ...databaseReorder,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ctx.repo.reorder(ctx.workspaceId, input.ids);
            return { ids: input.ids };
        }
    }),
    defineSdkFeature({
        ...databaseDevices,
        access: { level: 'write' },
        handler: async (ctx: Ctx) => ({ devices: await relayDeviceOptions(ctx, 'cette base') })
    })
];

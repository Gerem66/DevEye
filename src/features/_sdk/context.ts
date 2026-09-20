import type { SdkFeatureContext, SdkProviders, SdkSocketTransport } from '@deveye/types/sdk/server';
import { env } from '@/Utils/Env';
import { signModuleTicket } from '@/auth/jwt';
import { sdkLive, serverKeysOf } from './host';
import { FeatureError } from '@deveye/types/sdk/server';
import {
    PROJECTS_USAGE_PROVIDER,
    resolveExtras,
    type FeatureManifest,
    type ProjectsUsageProvider
} from '@deveye/types/sdk';
import type { NotificationFeature } from '@deveye/types';

import type { FeatureContext } from '@/features/_define';
import { shareScope } from '@/features/_sharing';
import { sdkDomains } from './domains';
import { createFacade } from './facade';
import { accountChanged } from './live';
import { createQuota } from './quota';
import { createFeatureStore } from './store';

/**
 * Adapte le contexte natif en contexte SDK, par requête : rien de ce qui n'est
 * pas listé dans `SdkFeatureContext` ne traverse. Le repo du module est
 * construit une fois par processus (`register.ts`) ; le store et la façade se
 * construisent par requête, liés à l'espace de l'enveloppe.
 */
/**
 * Où vit DevEye, sans barre finale : l'origine des membres et celle joignable
 * sans le VPN (`AUDIENCE_ORIGIN`, sinon la même). Le serveur seul la connaît :
 * la déduire du navigateur serait faux en production.
 */
export const ORIGINS = {
    app: env.PUBLIC_ORIGIN.replace(/\/+$/, ''),
    public: (env.AUDIENCE_ORIGIN || env.PUBLIC_ORIGIN).replace(/\/+$/, '')
} as const;

export function createSdkContext(
    ctx: FeatureContext,
    manifest: FeatureManifest,
    repo: unknown,
    providers: SdkProviders
): SdkFeatureContext {
    const extras = resolveExtras(manifest.extraPermissions, ctx.isOwner, ctx.extrasFor(manifest.id));
    return {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        workspace: { id: ctx.workspace.id, kind: ctx.workspace.kind, name: ctx.workspace.name },
        isOwner: ctx.isOwner,
        isAdmin: ctx.isAdmin,
        canWrite: ctx.canFeature(manifest.id, 'write'),
        ...extras,
        repo,
        store: createFeatureStore(ctx.db.featureKv, manifest.id, ctx.workspaceId, {
            open: ctx.secure.open,
            guarded: ctx.secure
        }),
        cipher: (mode) => (mode === 'private' ? ctx.secure : ctx.secure.open),
        deveye: createFacade({
            db: ctx.db,
            cipher: ctx.secure.open,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            ownerUserId: ctx.workspace.ownerUserId,
            isAdmin: ctx.isAdmin,
            workspaceKind: ctx.workspace.kind,
            manifest,
            logger: ctx.logger,
            providers
        }),
        transport: socketTransport(ctx, manifest),
        secrecy: {
            isUnlocked: () => ctx.secure.isUnlocked(),
            // Signé par l'hôte, lié à la session de l'appelant et à ce module
            // (l'audience) ; son service le rend contre les codecs de l'appelant.
            ticket: (payload, opts) =>
                signModuleTicket(
                    manifest.id,
                    { userId: ctx.userId, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, payload },
                    opts?.ttlSeconds ?? 120
                )
        },
        keys: serverKeysOf(ctx.crypt, manifest.id),
        live: {
            publish: (event, payload) => publishFrame(manifest, ctx.workspaceId, event, payload),
            accountChanged: (userId) => accountChanged(ctx.db, manifest, userId)
        },
        // Le compte visé est le propriétaire de l'espace, pas l'appelant : dans
        // un espace partagé, ce qu'un membre crée pèse sur l'offre de son hôte.
        quota: createQuota(ctx.db, providers, manifest, () => Promise.resolve(ctx.workspace.ownerUserId), ctx.logger),
        items: {
            // Liées à la feature du module : un module ne peut pas interroger
            // les restrictions d'une autre.
            restrictions: () => ctx.itemRestrictions(manifest.id),
            assert: (itemId, level) => ctx.assertItem(manifest.id, itemId, level),
            // La surcharge de l'élément prime sur le droit du rôle, dans les
            // deux sens. Pour une garde qui ne couvre qu'une partie d'une
            // commande ; celle qui la couvre entière se déclare en `access`.
            canExtra: async (itemId, key) => {
                const override = (await ctx.itemExtraOverrides(manifest.id)).get(itemId)?.[key];
                return override ?? extras.canExtra(key);
            },
            // Le ménage d'un élément supprimé : projections, restrictions, route
            // de notification et liaisons de projets, qu'aucune clé étrangère ne
            // rattache à sa table. Les liaisons tombent chez lui et dans chaque
            // espace qui le recevait : plus personne n'y voit l'élément.
            forget: async (itemId) => {
                const shares = await ctx.db.itemSharing.sharesOf(manifest.id, itemId, ctx.workspaceId);
                await ctx.db.itemSharing.forgetItem(manifest.id, itemId, ctx.workspaceId);
                const numericItem = Number(itemId);
                const projects = providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
                if (projects && Number.isInteger(numericItem)) {
                    for (const workspaceId of new Set([ctx.workspaceId, ...shares.map((s) => s.workspace_id)])) {
                        await projects.detach(manifest.id, numericItem, workspaceId);
                    }
                }
                // Les routes de notification sont à clé numérique : une feature
                // dont les éléments ont un identifiant texte n'en a aucune.
                const routeItemId = Number(itemId);
                if (Number.isInteger(routeItemId)) {
                    await ctx.db.notificationChannels.clearRoute(
                        ctx.workspaceId,
                        manifest.id as NotificationFeature,
                        routeItemId
                    );
                }
            }
        },
        sharing: {
            scope: async () => {
                // `shareTier: 'never'` dit qu'aucune ligne ne voyage : interroger
                // quand même les projections est une erreur de contrat.
                if (manifest.shareTier === 'never') {
                    throw new FeatureError('forbidden', "Declare a shareTier other than 'never' to read projections");
                }
                const scope = await shareScope(ctx, manifest.id);
                return {
                    foreignIds: scope.foreignIds,
                    homeOf: scope.homeOf,
                    orderOf: scope.orderOf,
                    // Le Cipher de l'app est structurellement un SdkCipher.
                    cipherFor: (itemId) => scope.cipherFor(itemId)
                };
            },
            setOrder: (itemId, order) => ctx.db.itemSharing.setOrder(ctx.workspaceId, manifest.id, itemId, order)
        },
        domains: sdkDomains(ctx.db, manifest, ctx.workspaceId),
        providers,
        audit: (entry) =>
            ctx.audit({
                action: entry.action,
                description: entry.description,
                level: entry.level,
                metadata: entry.metadata ?? null
            }),
        logger: ctx.logger,
        requestId: ctx.requestId,
        origins: ORIGINS
    };
}

/**
 * La voie de poussée d'un module. Deux gardes, et rien d'autre : la capacité
 * déclarée, et le nom de l'événement sous le préfixe du module, la même règle
 * structurelle que ses commandes et ses sujets. La charge n'est pas relue :
 * elle traverse telle quelle, comme celle d'une réponse de commande.
 */
export function publishFrame(manifest: FeatureManifest, workspaceId: number, event: string, payload: unknown): void {
    if (!(manifest.nativeCapabilities ?? []).includes('live.publish')) {
        throw new FeatureError('forbidden', `Module « ${manifest.id} » : declare 'live.publish' in nativeCapabilities`);
    }
    if (!event.startsWith(`${manifest.id}.`)) {
        throw new FeatureError('validation', `Event « ${event} » must start with « ${manifest.id}. »`);
    }
    sdkLive().publishFeature(workspaceId, manifest.id, event, payload);
}

/**
 * Le transport du socket appelant : le `monitor` natif, réduit à sa part sync
 * et gardé par la capacité 'agents'. Hors socket (tests), chaque appel lève.
 */
function socketTransport(ctx: FeatureContext, manifest: FeatureManifest): SdkSocketTransport {
    const monitor = (): NonNullable<FeatureContext['monitor']> => {
        if (!(manifest.nativeCapabilities ?? []).includes('agents')) {
            throw new FeatureError('forbidden', "Declare 'agents' in the manifest's nativeCapabilities");
        }
        if (!ctx.monitor) throw new FeatureError('internal', 'Transport indisponible hors socket');
        return ctx.monitor;
    };
    return {
        subscribeSync: (shareIds) => monitor().subscribeSync(shareIds),
        unsubscribeSync: (shareIds) => monitor().unsubscribeSync(shareIds),
        sendSyncChunk: (payload) => monitor().sendSyncChunk(payload),
        syncChunkBuffered: () => monitor().syncChunkBuffered()
    };
}

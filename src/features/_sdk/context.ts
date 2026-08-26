import type { SdkFeatureContext, SdkSocketTransport } from '@deveye/types/sdk/server';
import { FeatureError } from '@deveye/types/sdk/server';
import { resolveExtras, type FeatureManifest } from '@deveye/types/sdk';

import type { FeatureContext } from '@/features/_define';
import { createFacade } from './facade';
import { createFeatureStore } from './store';

/**
 * Adapte le contexte natif en contexte SDK, par requête.
 *
 * C'est ici que la frontière se tient : rien de ce qui n'est pas listé dans
 * `SdkFeatureContext` ne traverse. Le repo du module est construit une fois
 * par processus (voir `register.ts`) et injecté ; le store et la façade se
 * construisent par requête, liés à l'espace de l'enveloppe.
 */
export function createSdkContext(ctx: FeatureContext, manifest: FeatureManifest, repo: unknown): SdkFeatureContext {
    return {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        workspace: { id: ctx.workspace.id, kind: ctx.workspace.kind, name: ctx.workspace.name },
        isOwner: ctx.isOwner,
        canWrite: ctx.canFeature(manifest.id, 'write'),
        ...resolveExtras(manifest.extraPermissions, ctx.isOwner, ctx.extrasFor(manifest.id)),
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
            ownerUserId: ctx.workspace.ownerUserId,
            isAdmin: ctx.isAdmin,
            manifest,
            logger: ctx.logger
        }),
        transport: socketTransport(ctx, manifest),
        audit: (entry) =>
            ctx.audit({
                action: entry.action,
                description: entry.description,
                level: entry.level,
                metadata: entry.metadata ?? null
            }),
        logger: ctx.logger,
        requestId: ctx.requestId
    };
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

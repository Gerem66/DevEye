import {
    cloudSyncBrowse,
    cloudSyncPauseShare,
    cloudSyncResumeShare,
    cloudSyncSubscribe,
    cloudSyncSyncNow,
    cloudSyncUnsubscribe,
    type CloudSyncFile,
    type SyncShareStatus
} from 'deveye-types';

import { safeRelPath } from '@/cloudSync/pathValidation';
import { defineFeature, FeatureError, type FeatureContext } from '../_define';
import { authorizeShare, requireEngine, toClientFile } from './_shared';

async function setShareStatus(ctx: FeatureContext, shareId: number, status: SyncShareStatus): Promise<void> {
    const share = await authorizeShare(ctx, shareId);
    const engine = requireEngine(ctx);
    await ctx.db.syncShares.setStatus(shareId, status);
    await engine.notifyConfigChanged(shareId);

    ctx.audit({
        action: status === 'paused' ? 'cloudSync.pauseShare' : 'cloudSync.resumeShare',
        description: `CloudSync : partage « ${share.name} » ${status === 'paused' ? 'mis en pause' : 'repris'}`,
        metadata: { shareId }
    });
}

export const cloudSyncPauseShareFeature = defineFeature({
    ...cloudSyncPauseShare,
    mutates: true,
    handler: async (ctx, input) => {
        await setShareStatus(ctx, input.shareId, 'paused');
        return { ok: true };
    }
});

export const cloudSyncResumeShareFeature = defineFeature({
    ...cloudSyncResumeShare,
    mutates: true,
    handler: async (ctx, input) => {
        await setShareStatus(ctx, input.shareId, 'active');
        return { ok: true };
    }
});

export const cloudSyncSyncNowFeature = defineFeature({
    ...cloudSyncSyncNow,
    handler: async (ctx, input) => {
        await authorizeShare(ctx, input.shareId);
        const started = await requireEngine(ctx).syncNow(input.shareId, input.deviceId);
        return { started };
    }
});

export const cloudSyncSubscribeFeature = defineFeature({
    ...cloudSyncSubscribe,
    handler: async (ctx, input) => {
        if (!ctx.monitor) throw new FeatureError('internal', 'Connexion temps réel requise');
        for (const shareId of input.shareIds) await authorizeShare(ctx, shareId);
        ctx.monitor.subscribeSync(input.shareIds);
        return requireEngine(ctx).liveSnapshot(input.shareIds);
    }
});

export const cloudSyncUnsubscribeFeature = defineFeature({
    ...cloudSyncUnsubscribe,
    handler: async (ctx, input) => {
        ctx.monitor?.unsubscribeSync(input.shareIds);
        return { ok: true };
    }
});

export const cloudSyncBrowseFeature = defineFeature({
    ...cloudSyncBrowse,
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const dir = input.dir === '' ? '' : safeRelPath(input.dir);
        if (dir === null) throw new FeatureError('validation', 'Chemin invalide');

        // L'index est plat (une ligne par fichier) : les dossiers du niveau
        // demandé sont déduits du premier segment restant de chaque chemin.
        const rows = await ctx.db.syncFiles.browseByPrefix(share.id, dir);
        const dirs = new Set<string>();
        const files: CloudSyncFile[] = [];
        const prefixLen = dir === '' ? 0 : dir.length + 1;
        for (const row of rows) {
            const rest = row.rel_path.slice(prefixLen);
            const slash = rest.indexOf('/');
            if (slash === -1) files.push(toClientFile(row));
            else dirs.add(rest.slice(0, slash));
        }
        return { dirs: [...dirs].sort((a, b) => a.localeCompare(b, 'fr')), files };
    }
});

import {
    cloudSyncAttachDevice,
    cloudSyncDetachDevice,
    cloudSyncPauseDevice,
    cloudSyncResumeDevice,
    type SyncShareStatus
} from 'deveye-types';

import { hasControlChars } from '@/cloudSync/pathValidation';
import { authorizeDevice } from '../devices/shared';
import { defineFeature, FeatureError, type FeatureContext } from '../_define';
import { authorizeShare, requireActiveEngine, requireEngine } from './_shared';

/** Le chemin local est validé pour de bon par l'agent ; ici, garde-fous de base. */
function assertPlausibleLocalPath(localPath: string): string {
    const trimmed = localPath.trim();
    if (trimmed.length === 0 || hasControlChars(trimmed)) {
        throw new FeatureError('validation', 'Chemin local invalide.');
    }
    return trimmed;
}

async function setDeviceStatus(
    ctx: FeatureContext,
    shareId: number,
    deviceId: string,
    status: SyncShareStatus
): Promise<void> {
    const share = await authorizeShare(ctx, shareId);
    const engine = requireEngine(ctx);
    const changed = await ctx.db.syncShares.setDeviceStatus(shareId, deviceId, status);
    if (!changed) throw new FeatureError('not_found', 'Appareil non attaché à ce partage');
    await engine.notifyConfigChanged(shareId);

    ctx.audit({
        action: status === 'paused' ? 'cloudSync.pauseDevice' : 'cloudSync.resumeDevice',
        description: `CloudSync : appareil ${status === 'paused' ? 'mis en pause' : 'repris'} sur « ${share.name} »`,
        metadata: { shareId, deviceId }
    });
}

export const cloudSyncAttachDeviceFeature = defineFeature({
    ...cloudSyncAttachDevice,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const device = await authorizeDevice(ctx, input.deviceId);
        const engine = requireActiveEngine(ctx);
        if (await ctx.db.syncShares.findDevice(share.id, device.id)) {
            throw new FeatureError('conflict', 'Cet appareil est déjà attaché au partage');
        }
        await ctx.db.syncShares.attachDevice({
            shareId: share.id,
            deviceId: device.id,
            localPath: assertPlausibleLocalPath(input.localPath)
        });
        await engine.notifyConfigChanged(share.id);

        ctx.audit({
            action: 'cloudSync.attachDevice',
            description: `CloudSync : « ${device.name} » attaché au partage « ${share.name} »`,
            metadata: { shareId: share.id, deviceId: device.id, localPath: input.localPath }
        });
        return { ok: true };
    }
});

export const cloudSyncDetachDeviceFeature = defineFeature({
    ...cloudSyncDetachDevice,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const engine = requireActiveEngine(ctx);
        const removed = await ctx.db.syncShares.detachDevice(share.id, input.deviceId);
        if (!removed) throw new FeatureError('not_found', 'Appareil non attaché à ce partage');
        // La baseline part avec l'attache : un ré-attachement futur repart en
        // merge pur (aucune suppression inférable) — c'est voulu.
        await ctx.db.syncFiles.clearBaseline(share.id, input.deviceId);
        await engine.notifyDeviceDetached(input.deviceId);

        ctx.audit({
            action: 'cloudSync.detachDevice',
            description: `CloudSync : appareil détaché du partage « ${share.name} » (fichiers locaux conservés)`,
            metadata: { shareId: share.id, deviceId: input.deviceId }
        });
        return { ok: true };
    }
});

export const cloudSyncPauseDeviceFeature = defineFeature({
    ...cloudSyncPauseDevice,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        await setDeviceStatus(ctx, input.shareId, input.deviceId, 'paused');
        return { ok: true };
    }
});

export const cloudSyncResumeDeviceFeature = defineFeature({
    ...cloudSyncResumeDevice,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        await setDeviceStatus(ctx, input.shareId, input.deviceId, 'active');
        return { ok: true };
    }
});

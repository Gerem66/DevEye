import { cloudSyncAddExclusion, cloudSyncRemoveExclusion } from 'deveye-types';

import { validateExclusionPattern } from '@/cloudSync/exclusions';
import { defineFeature, FeatureError } from '../_define';
import { authorizeShare, requireActiveEngine, toClientExclusion } from './_shared';

export const cloudSyncAddExclusionFeature = defineFeature({
    ...cloudSyncAddExclusion,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const engine = requireActiveEngine(ctx);
        const problem = validateExclusionPattern(input.kind, input.pattern);
        if (problem !== null) throw new FeatureError('validation', problem);

        const row = await ctx.db.syncShares.addExclusion({
            shareId: share.id,
            kind: input.kind,
            pattern: input.pattern
        });
        // Les fichiers désormais exclus quittent le cloud (archivés en versions,
        // restaurables) ; les copies locales des appareils restent intactes.
        const removed = await engine.applyIndexHygiene(share);
        await engine.notifyConfigChanged(share.id);

        ctx.audit({
            action: 'cloudSync.addExclusion',
            description: `CloudSync : exclusion ajoutée sur « ${share.name} » (${input.kind} : ${input.pattern}${removed > 0 ? `, ${removed} fichier(s) retiré(s) du cloud` : ''})`,
            metadata: { shareId: share.id, kind: input.kind, pattern: input.pattern, removed }
        });
        return { exclusion: toClientExclusion(row) };
    }
});

export const cloudSyncRemoveExclusionFeature = defineFeature({
    ...cloudSyncRemoveExclusion,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const engine = requireActiveEngine(ctx);
        const removed = await ctx.db.syncShares.removeExclusion(input.exclusionId, share.id);
        if (!removed) throw new FeatureError('not_found', 'Exclusion introuvable');
        await engine.notifyConfigChanged(share.id);

        ctx.audit({
            action: 'cloudSync.removeExclusion',
            description: `CloudSync : exclusion retirée sur « ${share.name} »`,
            metadata: { shareId: share.id, exclusionId: input.exclusionId }
        });
        return { ok: true };
    }
});

import type { FeatureManifest } from '@deveye/types/sdk';
import {
    FeatureError,
    type FeatureServer,
    type SdkPlanPauses,
    type SdkProviders,
    type SdkQuota
} from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import { isPlanPaused, planPausedIds } from '@/Services/planPauses';
import { assertPlanLimit, isHeld, limitIn, planOf, planUsage } from '@/Services/quota';

function specOf(manifest: FeatureManifest, key: string) {
    const spec = manifest.quotas?.find((q) => q.key === key);
    if (!spec) throw new FeatureError('validation', `Quota « ${key} » absent du manifest de ${manifest.id}`);
    return spec;
}

/** Les pauses d'offre d'un module, sous ses clés courtes. Une clé qui n'est pas un stock lève. */
export function modulePauses(manifest: FeatureManifest): SdkPlanPauses {
    const fullKey = (key: string): string => {
        if (!specOf(manifest, key).stock) {
            throw new FeatureError('validation', `Quota « ${key} » de ${manifest.id} : pas un stock`);
        }
        return `${manifest.id}.${key}`;
    };
    return {
        isPaused: (key, itemId) => isPlanPaused(fullKey(key), itemId),
        paused: (key) => planPausedIds(fullKey(key))
    };
}

/** Ce que compte une clé d'un module, sur les espaces de son propriétaire. */
export type QuotaCounter = (key: string, ownerWorkspaceIds: readonly number[]) => Promise<number>;

/** Le compteur des quotas d'un module, lié à son repo : un stock par sa liste, un flux par son compte. */
export function quotaCounter(entries: FeatureServer['quotas'], repo: unknown): QuotaCounter {
    return async (key, ownerWorkspaceIds) => {
        const entry = entries?.[key];
        if (entry?.list) return (await entry.list(repo, ownerWorkspaceIds)).length;
        if (entry?.count) return entry.count(repo, ownerWorkspaceIds);
        throw new FeatureError('validation', `Quota « ${key} » : rien ne le compte`);
    };
}

/**
 * Les quotas d'un module, contre l'offre d'un compte. `ownerOf` dit lequel : le
 * propriétaire de l'espace, résolu à l'appel (un service ne le connaît pas
 * d'avance). Un propriétaire introuvable ne borne rien.
 */
export function createQuota(
    db: Pick<Database, 'workspaces'>,
    providers: SdkProviders,
    manifest: FeatureManifest,
    count: QuotaCounter,
    ownerOf: () => Promise<number | null>,
    logger: { error(obj: object, msg: string): void }
): SdkQuota {
    const pauses = modulePauses(manifest);
    return {
        ...pauses,
        limit: async (key) => {
            specOf(manifest, key);
            const ownerUserId = await ownerOf();
            if (ownerUserId === null) return null;
            return limitIn(await planOf(providers, ownerUserId, logger), `${manifest.id}.${key}`);
        },
        assert: async (key, countAfter) => {
            const spec = specOf(manifest, key);
            const ownerUserId = await ownerOf();
            if (ownerUserId === null) return;
            await assertPlanLimit(db, providers, logger, {
                ownerUserId,
                fullKey: `${manifest.id}.${key}`,
                label: spec.label,
                unit: spec.unit,
                countAfter
            });
        },
        usage: async (key) => {
            if (specOf(manifest, key).perOperation) {
                throw new FeatureError(
                    'validation',
                    `Quota « ${key} » de ${manifest.id} : limite par opération, rien à compter`
                );
            }
            const ownerUserId = await ownerOf();
            if (ownerUserId === null) return null;
            return planUsage(db, providers, logger, {
                ownerUserId,
                fullKey: `${manifest.id}.${key}`,
                used: (owned) => count(key, owned)
            });
        },
        assertActive: async (key, itemId) => {
            if (!pauses.isPaused(key, itemId)) return;
            const ownerUserId = await ownerOf();
            const plan = ownerUserId === null ? null : await planOf(providers, ownerUserId, logger);
            const fullKey = `${manifest.id}.${key}`;
            if (isHeld(plan)) {
                throw new FeatureError(
                    'quota_exceeded',
                    'En pause : forte affluence, le service est réservé aux abonnés pour le moment. Tout reprend de soi-même à la fin de cette période.',
                    { key: fullKey, limit: 0, plan: plan?.id, paused: true, priority: true }
                );
            }
            const limit = limitIn(plan, fullKey);
            throw new FeatureError(
                'quota_exceeded',
                `En pause : au-delà de ${limit ?? 0} ${specOf(manifest, key).label}, l'offre ${plan?.label ?? ''} met les plus récents en pause.`,
                { key: fullKey, limit, plan: plan?.id, paused: true }
            );
        }
    };
}

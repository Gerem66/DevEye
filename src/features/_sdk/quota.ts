import type { FeatureManifest } from '@deveye/types/sdk';
import { FeatureError, type SdkProviders, type SdkQuota } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import { assertPlanLimit, limitIn, planOf } from '@/Services/quota';

/**
 * Les quotas d'un module, contre l'offre d'un compte. `ownerOf` dit lequel : le
 * propriétaire de l'espace, résolu à l'appel (un service ne le connaît pas
 * d'avance). Un propriétaire introuvable ne borne rien.
 */
export function createQuota(
    db: Pick<Database, 'workspaces'>,
    providers: SdkProviders,
    manifest: FeatureManifest,
    ownerOf: () => Promise<number | null>,
    logger: { error(obj: object, msg: string): void }
): SdkQuota {
    const specOf = (key: string) => {
        const spec = manifest.quotas?.find((q) => q.key === key);
        if (!spec) throw new FeatureError('validation', `Quota « ${key} » absent du manifest de ${manifest.id}`);
        return spec;
    };
    return {
        limit: async (key) => {
            specOf(key);
            const ownerUserId = await ownerOf();
            if (ownerUserId === null) return null;
            return limitIn(await planOf(providers, ownerUserId, logger), `${manifest.id}.${key}`);
        },
        assert: async (key, countAfter) => {
            const spec = specOf(key);
            const ownerUserId = await ownerOf();
            if (ownerUserId === null) return;
            await assertPlanLimit(db, providers, logger, {
                ownerUserId,
                fullKey: `${manifest.id}.${key}`,
                label: spec.label,
                unit: spec.unit,
                countAfter
            });
        }
    };
}

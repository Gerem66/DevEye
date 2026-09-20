import type { FeatureManifest } from '@deveye/types/sdk';
import { FeatureError, type SdkProviders, type SdkQuota } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import { limitIn, ownedWorkspaceIds, planOf } from '@/Services/quota';

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** Une limite en octets, écrite comme une taille : « 1 Go ». */
function sizeFr(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace('.', ',')} ${UNITS[unit]}`;
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
    ownerOf: () => Promise<number | null>,
    logger: { error(obj: object, msg: string): void }
): SdkQuota {
    const specOf = (key: string) => {
        const spec = manifest.quotas?.find((q) => q.key === key);
        if (!spec) throw new FeatureError('validation', `Quota « ${key} » absent du manifest de ${manifest.id}`);
        return spec;
    };
    const resolve = async (key: string) => {
        const ownerUserId = await ownerOf();
        const plan = ownerUserId === null ? null : await planOf(providers, ownerUserId, logger);
        return { ownerUserId, plan, limit: limitIn(plan, `${manifest.id}.${key}`) };
    };
    return {
        limit: async (key) => {
            specOf(key);
            return (await resolve(key)).limit;
        },
        assert: async (key, countAfter) => {
            const spec = specOf(key);
            const { ownerUserId, plan, limit } = await resolve(key);
            if (limit === null || ownerUserId === null) return;
            const count = await countAfter(await ownedWorkspaceIds(db, ownerUserId));
            if (count <= limit) return;
            const shown = spec.unit === 'bytes' ? sizeFr(limit) : String(limit);
            throw new FeatureError(
                'quota_exceeded',
                `Limite de l'offre ${plan?.label ?? ''} atteinte : ${shown} ${spec.label}.`,
                { feature: manifest.id, key, limit, plan: plan?.id }
            );
        }
    };
}

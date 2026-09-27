import type { z } from 'zod';
import { FeatureError, type SdkCipher, type SdkQuota } from '@deveye/types/sdk/server';

import type { audienceSiteAdd } from '../contracts/commands';
import type { AudienceSiteRow } from '../contracts/domain';
import type { AudienceRepo } from './repo';
import { generatePublicKey, ingestOf, nameRef, packOrigins, packTransitPaths, type StoredSite } from './_shared';

export type SiteBody = z.infer<typeof audienceSiteAdd.input>;

/**
 * Déclare un site : un nom libre dans l'espace, la limite de l'offre, puis la
 * ligne chiffrée sous le codec ouvert. La déclaration d'un membre et le suivi
 * d'usage de DevEye passent tous deux par ici.
 */
export async function createSiteRecord(
    { repo, cipher, quota }: { repo: AudienceRepo; cipher: SdkCipher; quota: SdkQuota },
    workspaceId: number,
    input: SiteBody
): Promise<AudienceSiteRow> {
    const ref = nameRef(input.name);
    if (await repo.findByName(workspaceId, ref)) {
        throw new FeatureError('validation', 'Un site porte déjà ce nom dans cet espace.');
    }
    await quota.assert('sites', async (owned) => (await repo.countInWorkspaces(owned)) + 1);

    const body: StoredSite = {
        name: input.name.trim(),
        description: input.description.trim(),
        transitPaths: packTransitPaths(input.transitPaths)
    };
    const created = await repo.create({
        workspaceId,
        publicKey: generatePublicKey(),
        nameRef: ref,
        platform: input.platform,
        visitorMode: input.visitorMode,
        origins: packOrigins(input.origins),
        active: input.active,
        retentionDays: input.retentionDays,
        formsAuto: input.formsAuto,
        submissionIpQuota: input.submissionIpQuota,
        submissionBanQuota: input.submissionBanQuota,
        formHourlyQuota: input.formHourlyQuota,
        eventIpQuota: input.eventIpQuota,
        content: await cipher.encrypt(JSON.stringify(body))
    });
    ingestOf()?.invalidate();
    return created;
}

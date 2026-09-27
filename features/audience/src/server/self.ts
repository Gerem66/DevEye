import type { AudienceSelfProvider } from '@deveye/types/sdk';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';

import {
    AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
    AUDIENCE_RETENTION_DEFAULT_DAYS,
    AUDIENCE_SUBMISSION_BAN_QUOTA_DEFAULT,
    AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT
} from '../contracts/domain';
import type { AudienceRepo } from './repo';
import type { AudienceIngest } from './service';
import { createSiteRecord } from './sites';
import { readJson, type StoredSite } from './_shared';

/**
 * Le suivi d'usage de DevEye lui-même : l'app déclare ici le site où elle
 * relève ses pages et ses actions, puis y dépose ses mesures sans passer par
 * la route publique. Le site est anonyme, et sans plafond par adresse : tous
 * les membres derrière un même réseau d'entreprise ne sont qu'une adresse.
 */
export function createSelfProvider(
    deps: FeatureServiceDeps<AudienceRepo>,
    ingest: AudienceIngest
): AudienceSelfProvider {
    return {
        async createSite(workspaceId, { name, host }) {
            const row = await createSiteRecord(
                { repo: deps.repo, cipher: deps.cipherFor(workspaceId), quota: deps.quotaFor(workspaceId) },
                workspaceId,
                {
                    name,
                    description: 'L’usage de cette instance de DevEye, relevé par le serveur lui-même.',
                    platform: 'web',
                    visitorMode: 'anonymous',
                    origins: [host],
                    active: true,
                    retentionDays: AUDIENCE_RETENTION_DEFAULT_DAYS,
                    formsAuto: false,
                    submissionIpQuota: AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT,
                    submissionBanQuota: AUDIENCE_SUBMISSION_BAN_QUOTA_DEFAULT,
                    formHourlyQuota: AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
                    eventIpQuota: 0,
                    transitPaths: []
                }
            );
            deps.live.changed(workspaceId);
            return { siteId: row.id, workspaceId, name, active: true, publicKey: row.public_key };
        },

        async findByKey(publicKey) {
            const row = await deps.repo.findByPublicKey(publicKey);
            if (!row) return null;
            const stored = await readJson<Partial<StoredSite>>(deps.cipherFor(row.workspace_id), row.content);
            return {
                siteId: row.id,
                workspaceId: row.workspace_id,
                name: typeof stored?.name === 'string' ? stored.name : '',
                active: Boolean(row.active)
            };
        },

        ingest({ key, ip, userAgent, events }) {
            void ingest
                .accept({
                    key,
                    origin: null,
                    ip,
                    userAgent,
                    trusted: true,
                    events: events.map(({ at, ...event }) => ({
                        ...event,
                        ...(at !== undefined ? { at: Math.floor(at / 1000) } : {})
                    }))
                })
                .catch(() => undefined);
        }
    };
}

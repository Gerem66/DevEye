import type { AudienceSelfProvider } from '@deveye/types/sdk';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';

import {
    AUDIENCE_EVENT_IP_QUOTA_DEFAULT,
    AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
    AUDIENCE_RETENTION_DEFAULT_DAYS,
    AUDIENCE_SUBMISSION_BAN_QUOTA_DEFAULT,
    AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT,
    type AudienceFormField
} from '../contracts/domain';
import { createFormRecord } from './forms';
import type { AudienceRepo } from './repo';
import type { AudienceIngest } from './service';
import { createSiteRecord } from './sites';
import { nameRef, readJson, type StoredSite } from './_shared';

/**
 * Le suivi d'usage de DevEye lui-même : l'app déclare ici le site où elle
 * relève ses pages et ses actions, puis y dépose ses mesures sans passer par
 * la route publique, et un site par page publique (page d'état, site vitrine)
 * que la balise mesure comme n'importe quel site tiers. Tous anonymes.
 */
export function createSelfProvider(
    deps: FeatureServiceDeps<AudienceRepo>,
    ingest: AudienceIngest
): AudienceSelfProvider {
    return {
        async createSite(workspaceId, { name, host, description, measuredBy }) {
            const row = await createSiteRecord(
                { repo: deps.repo, cipher: deps.cipherFor(workspaceId), quota: deps.quotaFor(workspaceId) },
                workspaceId,
                {
                    name,
                    description,
                    platform: 'web',
                    visitorMode: 'anonymous',
                    origins: [host],
                    active: true,
                    retentionDays: AUDIENCE_RETENTION_DEFAULT_DAYS,
                    formsAuto: false,
                    submissionIpQuota: AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT,
                    submissionBanQuota: AUDIENCE_SUBMISSION_BAN_QUOTA_DEFAULT,
                    formHourlyQuota: AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
                    // Le serveur dépose lui-même les mesures de l'app, et tous ses
                    // membres derrière un même réseau ne sont qu'une adresse : aucun
                    // plafond. Une page mesurée par la balise garde celui d'un site neuf.
                    eventIpQuota: measuredBy === 'server' ? 0 : AUDIENCE_EVENT_IP_QUOTA_DEFAULT,
                    transitPaths: []
                }
            );
            deps.live.changed(workspaceId);
            return { siteId: row.id, workspaceId, name, active: true, publicKey: row.public_key };
        },

        async declareForm(workspaceId, siteId, { name, fields }) {
            const existing = await deps.repo.findFormByName(siteId, nameRef(name));
            if (existing) return { formId: Number(existing.id) };
            const declared: AudienceFormField[] = fields.map((field) => ({
                name: field.name,
                kind: field.kind,
                required: field.required,
                choices: [...(field.choices ?? [])],
                multiple: field.multiple ?? false
            }));
            const formId = await createFormRecord({ repo: deps.repo, cipher: deps.cipherFor(workspaceId) }, siteId, {
                name,
                mode: 'strict',
                fields: declared
            });
            deps.live.changed(workspaceId);
            return { formId };
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

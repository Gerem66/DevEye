import type { FeatureE2eEntry } from '@deveye/types/sdk/server';

import {
    AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
    AUDIENCE_RETENTION_DEFAULT_DAYS,
    AUDIENCE_SUBMISSION_BAN_QUOTA_DEFAULT,
    AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT,
    type AudienceSite
} from '../contracts/domain';
import type { AudienceRepo } from './repo';

/** Une origine qui n'existe nulle part (RFC 2606) : seul l'essai s'en réclame. */
const ORIGIN = 'https://e2e.invalid';
/** Un navigateur quelconque : le filtre anti-robots écarterait un agent sans nom. */
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

/** Un site suivi : sa déclaration, une visite reçue par la route publique, puis comptée. */
export const audienceE2e: FeatureE2eEntry<AudienceRepo> = {
    scenarios: [
        {
            id: 'visit',
            label: 'Recevoir et compter une visite',
            steps: [
                {
                    label: 'Déclarer un site',
                    run: async (ctx) => {
                        const { site } = await ctx.send<{ site: AudienceSite }>('audience.siteAdd', {
                            name: 'Essai de bout en bout',
                            description: '',
                            platform: 'web',
                            visitorMode: 'anonymous',
                            origins: [new URL(ORIGIN).host],
                            active: true,
                            retentionDays: AUDIENCE_RETENTION_DEFAULT_DAYS,
                            formsAuto: false,
                            submissionIpQuota: AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT,
                            submissionBanQuota: AUDIENCE_SUBMISSION_BAN_QUOTA_DEFAULT,
                            formHourlyQuota: AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
                            eventIpQuota: 0,
                            transitPaths: []
                        });
                        ctx.state.set('site', site);
                        ctx.defer('Supprimer le site', async () => {
                            await ctx.send('audience.siteRemove', { siteId: site.id });
                        });
                        return `Site ${site.id}`;
                    }
                },
                {
                    label: 'Envoyer une visite par la route publique',
                    run: async (ctx) => {
                        const site = ctx.state.get('site') as AudienceSite;
                        const reply = await ctx.fetch('/api/t/b', {
                            method: 'POST',
                            headers: { origin: ORIGIN, 'content-type': 'text/plain', 'user-agent': USER_AGENT },
                            body: JSON.stringify({ key: site.publicKey, events: [{ type: 'view', path: '/essai' }] })
                        });
                        if (reply.status !== 204) throw new Error(`La route publique a répondu ${reply.status}`);
                    }
                },
                {
                    label: 'La voir comptée',
                    run: async (ctx) => {
                        const site = ctx.state.get('site') as AudienceSite;
                        const views = await ctx.waitFor(
                            async () => {
                                const { metrics } = await ctx.send<{ metrics: { views: number } }>(
                                    'audience.overview',
                                    {
                                        siteId: site.id,
                                        range: '24h'
                                    }
                                );
                                return metrics.views > 0 ? metrics.views : null;
                            },
                            { timeoutMs: 15_000, intervalMs: 1000, what: 'La visite' }
                        );
                        return `${views} vue(s)`;
                    }
                }
            ]
        }
    ]
};

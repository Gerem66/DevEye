import type { FeatureE2eEntry } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : le scénario s'écarte
// de lui-même là où la surveillance refuserait l'adresse.
import { isAllowedOutboundUrl } from '@/Services/netFetch';

import type { UptimeService } from '../contracts/domain';
import type { UptimeRepo } from './repo';

/** Une surveillance de ce serveur même : la création, une vérification à la demande, le verdict, la suppression. */
export const uptimeE2e: FeatureE2eEntry<UptimeRepo> = {
    scenarios: [
        {
            id: 'monitor',
            label: 'Surveiller ce serveur',
            skip: ({ origins }) =>
                isAllowedOutboundUrl(`${origins.app}/api/health`)
                    ? null
                    : 'L’adresse de ce serveur est privée : une surveillance ne peut pas la joindre',
            steps: [
                {
                    label: 'Créer la surveillance',
                    run: async (ctx) => {
                        const url = `${ctx.origins.app}/api/health`;
                        const { service } = await ctx.send<{ service: UptimeService }>('uptime.add', {
                            service: {
                                name: 'Essai de bout en bout',
                                url,
                                integrityIntervalSeconds: null,
                                paths: [],
                                method: 'GET',
                                expectedStatus: 200,
                                keyword: null,
                                intervalSeconds: 300,
                                timeoutSeconds: 10,
                                failureThreshold: 1,
                                retentionDays: 1,
                                enabled: true
                            }
                        });
                        ctx.state.set('serviceId', service.id);
                        // Le planificateur tient la surveillance en mémoire : la
                        // cascade du compte ne l'y retirerait pas.
                        ctx.defer('Retirer la surveillance', async () => {
                            try {
                                await ctx.send('uptime.remove', { id: service.id });
                            } catch (e) {
                                if ((e as { code?: string }).code !== 'not_found') throw e;
                            }
                        });
                        return url;
                    }
                },
                {
                    label: 'Vérifier à la demande',
                    run: async (ctx) => {
                        await ctx.send('uptime.checkNow', { id: ctx.state.get('serviceId') });
                    }
                },
                {
                    label: 'Attendre le verdict « en ligne »',
                    run: async (ctx) => {
                        const id = ctx.state.get('serviceId');
                        const service = await ctx.waitFor(
                            async () => {
                                const { services } = await ctx.send<{ services: UptimeService[] }>('uptime.list', {});
                                const found = services.find((s) => s.id === id);
                                return found && found.status !== 'unknown' ? found : null;
                            },
                            { timeoutMs: 20_000, intervalMs: 1000, what: 'Le verdict de la surveillance' }
                        );
                        if (service.status !== 'up') {
                            throw new Error(
                                `Surveillance « ${service.status} » (HTTP ${service.lastHttpStatus ?? '?'})`
                            );
                        }
                        return `HTTP ${service.lastHttpStatus ?? '?'}`;
                    }
                }
            ]
        }
    ]
};

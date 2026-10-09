import type { FeatureE2eEntry } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : le scénario s'écarte
// de lui-même là où la surveillance refuserait l'adresse.
import { isAllowedOutboundUrl } from '@/Services/netFetch';

import type { UptimeIntegrityReading, UptimeService } from '../contracts/domain';
import { DEPLOY_HOOK_PATH } from './deploySources';
import type { UptimeRepo } from './repo';

const unreachable = (origin: string) =>
    isAllowedOutboundUrl(`${origin}/api/health`)
        ? null
        : 'L’adresse de ce serveur est privée : une surveillance ne peut pas la joindre';

/** La surveillance des fichiers de ce serveur, telle que `uptime.update` la reprend en entier. */
const WATCH_FILES = {
    name: 'Essai de bout en bout : adresse d’appel',
    integrityIntervalSeconds: 3600,
    paths: [],
    method: 'GET' as const,
    expectedStatus: null,
    keyword: null,
    intervalSeconds: 3600,
    timeoutSeconds: 30,
    failureThreshold: 3,
    retentionDays: 1,
    enabled: true
};

/**
 * Une surveillance de ce serveur même : la création, une vérification à la
 * demande, le verdict, la suppression ; puis son adresse d'appel, frappée comme
 * une CI le ferait, qui fait relire les fichiers.
 */
export const uptimeE2e: FeatureE2eEntry<UptimeRepo> = {
    scenarios: [
        {
            id: 'monitor',
            label: 'Surveiller ce serveur',
            skip: ({ origins }) => unreachable(origins.app),
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
        },
        {
            id: 'deployHook',
            label: 'Annoncer une mise en ligne',
            skip: ({ origins }) => unreachable(origins.app),
            steps: [
                {
                    label: 'Surveiller les fichiers de ce serveur',
                    run: async (ctx) => {
                        const url = `${ctx.origins.app}/`;
                        const { service } = await ctx.send<{ service: UptimeService }>('uptime.add', {
                            service: { ...WATCH_FILES, url }
                        });
                        ctx.state.set('serviceId', service.id);
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
                    label: 'Ouvrir son adresse d’appel',
                    run: async (ctx) => {
                        const id = ctx.state.get('serviceId');
                        await ctx.send('uptime.update', {
                            id,
                            service: {
                                ...WATCH_FILES,
                                url: `${ctx.origins.app}/`,
                                deploySources: [],
                                deployHook: true
                            }
                        });
                        const { url } = await ctx.send<{ url: string }>('uptime.deployHook', { id });
                        ctx.state.set('hookPath', url.slice(url.indexOf(DEPLOY_HOOK_PATH)));
                        return 'Adresse obtenue';
                    }
                },
                {
                    label: 'L’appeler comme une CI',
                    run: async (ctx) => {
                        const before = await readingsOf(ctx, ctx.state.get('serviceId'));
                        ctx.state.set('readings', before.length);
                        const reply = await ctx.fetch(ctx.state.get('hookPath') as string, { method: 'POST' });
                        if (reply.status !== 204) throw new Error(`L’adresse d’appel a répondu ${reply.status}`);
                    }
                },
                {
                    label: 'Voir les fichiers relus',
                    run: async (ctx) => {
                        const id = ctx.state.get('serviceId');
                        const known = ctx.state.get('readings') as number;
                        const latest = await ctx.waitFor(
                            async () => {
                                const readings = await readingsOf(ctx, id);
                                return readings.length > known ? readings[0] : null;
                            },
                            { timeoutMs: 60_000, intervalMs: 1000, what: 'La lecture des fichiers' }
                        );
                        return latest.outcome;
                    }
                }
            ]
        }
    ]
};

async function readingsOf(
    ctx: { send<T>(command: string, input: unknown): Promise<T> },
    id: unknown
): Promise<UptimeIntegrityReading[]> {
    const { readings } = await ctx.send<{ readings: UptimeIntegrityReading[] }>('uptime.integrityReadings', {
        id,
        limit: 20
    });
    return readings;
}

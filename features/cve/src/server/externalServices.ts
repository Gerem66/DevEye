import type { SdkExternalService, SdkExternalServicesContext } from '@deveye/types/sdk/server';

import { eolHealth } from './matching/eol';
import { osvHealth } from './matching/osv';
import { registryHealth } from './matching/registry';
import type { CveRepo } from './repo';

const time = (ms: number): string => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

/** Au-delà, le fil du NVD est en retard : la veille le dit sur ses constats. */
const NVD_LATE_S = 24 * 3600;

/**
 * Le NVD et OSV, tels que la veille les a vus, sans appel de plus : le
 * catalogue s'ingère tout seul, et OSV répond aux évaluations.
 */
export async function cveExternalServices({
    repo
}: SdkExternalServicesContext<CveRepo>): Promise<SdkExternalService[]> {
    const ingestedAt = await repo.getState('ingestedAt');
    const watched = await repo.listWatched();
    const filling = watched.filter((w) => w.backfilled_at === null).length;
    const late = ingestedAt === null || Date.now() / 1000 - ingestedAt > NVD_LATE_S;
    const cache = await repo.osvCacheSize();
    const paused = Date.now() < osvHealth.blockedUntil;
    const failed = osvHealth.lastFailure !== null && osvHealth.lastFailure.at > osvHealth.lastOkAt;
    const eolAt = await repo.getState('eolFetchedAt');
    const eolLate = eolAt === null || Date.now() / 1000 - eolAt > 2 * NVD_LATE_S;
    const registryPaused = Date.now() < registryHealth.blockedUntil;
    const registryFailed =
        registryHealth.lastFailure !== null && registryHealth.lastFailure.at > registryHealth.lastOkAt;
    return [
        {
            id: 'nvd',
            name: 'NVD',
            provider: 'NIST, National Vulnerability Database',
            state: late ? 'degraded' : 'ok',
            summary: late
                ? 'Le fil n’a pas été ingéré depuis plus d’un jour : la veille ne garantit plus les produits qu’elle compare.'
                : 'Le catalogue des CVE, ingéré toutes les trente minutes, dont la veille compare les produits.',
            facts: [
                { label: 'Dernier tour', value: ingestedAt === null ? 'aucun' : time(ingestedAt * 1000) },
                {
                    label: 'Produits suivis',
                    value: filling > 0 ? `${watched.length}, dont ${filling} en rattrapage` : String(watched.length)
                }
            ]
        },
        {
            id: 'osv',
            name: 'OSV.dev',
            provider: 'Google, Open Source Security',
            state: paused ? 'degraded' : failed ? 'down' : 'ok',
            summary: paused
                ? `En pause jusqu’à ${time(osvHealth.blockedUntil)} : ${osvHealth.lastFailure?.reason ?? ''} La veille garde ses constats de paquets d’avant.`
                : 'Le catalogue des failles connues des paquets, interrogé par la veille CVE.',
            facts: [
                {
                    label: 'Dernière réponse',
                    value: osvHealth.lastOkAt ? time(osvHealth.lastOkAt) : 'aucune depuis le démarrage'
                },
                ...(osvHealth.lastFailure
                    ? [
                          {
                              label: 'Dernier refus',
                              value: `${time(osvHealth.lastFailure.at)}, ${osvHealth.lastFailure.reason}`,
                              tone: 'warning' as const
                          }
                      ]
                    : []),
                { label: 'En cache', value: `${cache.queries} paquets, ${cache.vulns} avis` }
            ]
        },
        {
            id: 'endoflife',
            name: 'endoflife.date',
            provider: 'Projet communautaire endoflife.date',
            state: eolLate ? 'degraded' : 'ok',
            summary: eolLate
                ? 'Le catalogue des fins de vie n’a pas été relu depuis plus de deux jours : la veille garde le précédent.'
                : 'Les fins de vie des systèmes, logiciels et frameworks, relues une fois par jour.',
            facts: [
                { label: 'Dernière lecture', value: eolAt === null ? 'aucune' : time(eolAt * 1000) },
                ...(eolHealth.lastFailure
                    ? [
                          {
                              label: 'Dernier échec',
                              value: `${time(eolHealth.lastFailure.at)}, ${eolHealth.lastFailure.reason}`,
                              tone: 'warning' as const
                          }
                      ]
                    : [])
            ]
        },
        {
            id: 'depsdev',
            name: 'deps.dev',
            provider: 'Google, Open Source Insights',
            state: registryPaused ? 'degraded' : registryFailed ? 'down' : 'ok',
            summary: registryPaused
                ? `En pause jusqu’à ${time(registryHealth.blockedUntil)} : ${registryHealth.lastFailure?.reason ?? ''}`
                : 'La dernière version et la dépréciation des dépendances directes, interrogées par la veille CVE.',
            facts: [
                {
                    label: 'Dernière réponse',
                    value: registryHealth.lastOkAt ? time(registryHealth.lastOkAt) : 'aucune depuis le démarrage'
                }
            ]
        }
    ];
}

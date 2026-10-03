import { domainOwnershipRecord, type FeatureService } from '@deveye/types/sdk/server';

import type { FeatureDomainRow } from '@/db/repos/featureDomains';
import { moduleDomainFeatures, moduleDomains } from '@/features/_sdk/register';
import { ORIGINS } from '@/features/_sdk/context';
import { toSdkDomain, type DomainsHost } from '@/features/_sdk/domains';
import type { LiveHub } from '@/live/hub';
import { env } from '@/Utils/Env';
import { systemDns } from './dns';
import { judge, verdictChanged } from './engine';
import { httpsMode } from './proxy';
import { webCheck } from './web';

const BATCH = 20;

/**
 * Vérifie un domaine et enregistre le verdict : le seul point qui écrit son
 * état. Rend la ligne à jour, et si ce qu'un membre en voit a bougé. `null`
 * quand la fonctionnalité qui le tient n'est plus installée.
 */
export async function verifyFeatureDomain(
    host: DomainsHost,
    row: FeatureDomainRow,
    now: number
): Promise<{ row: FeatureDomainRow; changed: boolean } | null> {
    const hooks = moduleDomains(row.feature, host);
    if (!hooks) return null;
    const domain = toSdkDomain(row);
    const web = hooks.manifest.domains?.web === true;
    const verdict = await judge(row, domainOwnershipRecord(row.feature, row.host, row.token), now, {
        txt: systemDns.txt,
        probe: async () => {
            const held = web
                ? await webCheck(row.host, {
                      originHost: new URL(ORIGINS.public).hostname,
                      auto: httpsMode() === 'auto',
                      verified: row.verified_at !== null
                  })
                : null;
            return held ?? hooks.probe(domain);
        },
        okSeconds: env.DOMAIN_OK_SECONDS,
        pendingSeconds: env.DOMAIN_PENDING_SECONDS
    });
    await host.db.featureDomains.saveState(row.id, verdict);
    return { row: { ...row, ...verdict }, changed: verdictChanged(row, verdict) };
}

/** La passe de fond : les domaines échus, toutes fonctionnalités installées confondues. */
export function createDomainVerifier(host: DomainsHost & { live: LiveHub }): FeatureService {
    let timer: ReturnType<typeof setInterval> | null = null;
    let ticking = false;

    const tick = async (): Promise<void> => {
        const now = Math.floor(Date.now() / 1000);
        const due = await host.db.featureDomains.due(now, BATCH, moduleDomainFeatures());
        for (const row of due) {
            const outcome = await verifyFeatureDomain(host, row, now);
            if (!outcome?.changed) continue;
            host.live.changed(row.workspace_id, ['domain'], null);
            if (!outcome.row.verified_at) {
                host.logger.info(
                    { cause: 'user', feature: row.feature, host: row.host, workspaceId: row.workspace_id },
                    'Domaine non vérifié'
                );
            }
        }
    };

    const run = async (): Promise<void> => {
        if (ticking) return;
        ticking = true;
        try {
            await tick();
        } catch (e) {
            host.logger.error({ err: (e as Error).message }, 'Domain verification pass failed');
        } finally {
            ticking = false;
        }
    };

    return {
        start: () => {
            if (timer) return;
            timer = setInterval(() => void run(), env.DOMAIN_PROBE_TICK_SECONDS * 1000);
            timer.unref();
        },
        stop: () => {
            if (timer) clearInterval(timer);
            timer = null;
        }
    };
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import type { DevicesRepo } from './repo';

/**
 * Le balayage de rétention, sur le harnais de service du SDK : un tick purge
 * les trois tables sous la durée de l'environnement, sans diffusion ni audit.
 *
 * `MONITORING_RETENTION_DAYS` est posée AVANT le chargement du module, parce
 * que `env.ts` lit l'environnement à l'import : d'où l'import dynamique.
 */

process.env.MONITORING_RETENTION_DAYS = '7';
const { serverEntry } = await import('./index');

async function unused(): Promise<never> {
    throw new Error('non attendu ici');
}

/** Un dépôt qui ne fait que consigner les purges demandées, avec leur durée. */
function fakeRepo(pruned: string[]): DevicesRepo {
    const prune = (table: string, removed: number) => async (days: number) => {
        pruned.push(`${table}:${days}`);
        return removed;
    };
    return {
        devices: {
            findById: unused,
            findByIds: unused,
            listVisible: unused,
            findVisible: unused,
            setStatus: unused,
            countActiveInWorkspaces: unused,
            rename: unused,
            setConfig: unused,
            requestDeletion: unused,
            cancelDeletion: unused,
            archive: unused,
            delete: unused,
            reorder: unused
        },
        linkCodes: { create: unused, listActive: unused, setAutoApprove: unused, revoke: unused },
        metrics: {
            query: unused,
            availableDaySummaries: unused,
            instantTimes: unused,
            setInstantsPinned: unused,
            deleteExpiredInRange: unused,
            pruneByRetention: prune('metrics', 3)
        },
        presence: { query: unused, onlineAt: unused, pruneByRetention: prune('presence', 0) },
        processSamples: {
            nearest: unused,
            snapshotTimes: unused,
            storage: unused,
            deleteRange: unused,
            deleteExpiredInRange: unused,
            pruneByRetention: prune('processSamples', 2)
        }
    };
}

describe('le balayage de rétention', () => {
    it('est un ticker horaire, et un tick purge les trois tables sous MONITORING_RETENTION_DAYS', async () => {
        const pruned: string[] = [];
        const deps = createTestServiceDeps<DevicesRepo>({ repo: fakeRepo(pruned) });
        assert.ok(serverEntry.createService, 'le module offre un service');
        serverEntry.createService(deps);

        assert.equal(deps.recorded.tickers.length, 1);
        assert.equal(deps.recorded.tickers[0].intervalMs, 60 * 60 * 1000);
        await deps.recorded.tickers[0].tick();
        assert.deepEqual(pruned.sort(), ['metrics:7', 'presence:7', 'processSamples:7']);
        // Une purge ne prévient personne et ne s'audite pas.
        assert.deepEqual(deps.recorded.liveChanges, []);
        assert.deepEqual(deps.recorded.audits, []);
    });

    it('démarre par un passage immédiat, sans attendre la cadence', async () => {
        const pruned: string[] = [];
        const deps = createTestServiceDeps<DevicesRepo>({ repo: fakeRepo(pruned) });
        const service = serverEntry.createService!(deps);
        await service.start();
        // Le passage de démarrage n'est pas attendu par `start` : on laisse la
        // boucle d'événements le conclure.
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(pruned.length, 3);
        await service.stop();
    });
});

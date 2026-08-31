import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { INGEST_MAX_PAGES, NVD_KEY_STORE_KEY } from './_shared';
import { nvdClient, type NvdClient } from './nvd';
import type { CveRepo } from './repo';

/**
 * L'ingestion du fil : un tour toutes les trente minutes, qui demande au NVD ce
 * qui a bougé depuis le curseur.
 *
 * Le catalogue est global, le ticker aussi : il ne parcourt les espaces que
 * pour deux choses, trouver une clé d'API et réveiller les clients.
 */

const TICK_MS = 30 * 60 * 1000;
/** Au premier démarrage, on ne remonte pas plus loin que ça. */
const FIRST_WINDOW_S = 7 * 24 * 3600;
/**
 * Ce qu'une fenêtre couvre. Une journée vaut environ un millier de CVE, ce qui
 * tient en une page et en une réponse que le NVD sait rendre : demander la
 * semaine d'un coup expirait avant la fin.
 */
const WINDOW_S = 24 * 3600;
/**
 * Combien de fenêtres un tour enchaîne. Le premier rattrape la semaine entière,
 * et un curseur en retard revient au présent au lieu d'abandonner ce qu'il a
 * manqué. Chaque fenêtre avance le curseur : un tour interrompu ne perd que la
 * fenêtre en cours.
 */
const MAX_WINDOWS_PER_TICK = 8;
/**
 * Le curseur recule un peu sur la fenêtre qu'il vient de lire : une CVE
 * modifiée pendant la requête tomberait sinon dans l'entre-deux. La relire est
 * sans effet, l'écriture étant idempotente.
 */
const OVERLAP_S = 300;
const RETENTION_S = 180 * 24 * 3600;
const PURGE_EVERY_S = 24 * 3600;

export function createService(deps: FeatureServiceDeps<CveRepo>, client: NvdClient = nvdClient): FeatureService {
    let lastPurgeAt = 0;
    let running = false;

    /**
     * N'importe quelle clé d'espace relève le quota de l'ingestion commune : le
     * catalogue est partagé, la facture du quota aussi.
     */
    async function anyApiKey(workspaceIds: readonly number[]): Promise<string | null> {
        for (const id of workspaceIds) {
            const key = await deps.storeFor(id).get(NVD_KEY_STORE_KEY);
            if (key && key.length > 0) return key;
        }
        return null;
    }

    async function purge(now: number): Promise<void> {
        if (now - lastPurgeAt < PURGE_EVERY_S) return;
        lastPurgeAt = now;
        const removed = await deps.repo.purge(now - RETENTION_S);
        if (removed > 0) deps.logger.info({ removed }, 'CVE anciennes oubliées');
    }

    async function tick(): Promise<void> {
        // Le premier tour part au démarrage, hors du rythme du ticker : sa garde
        // de réentrance ne couvre pas cet appel-là, d'où celle-ci.
        if (running) return;
        running = true;
        try {
            await ingest();
        } finally {
            running = false;
        }
    }

    async function ingest(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const workspaceIds = await deps.listWorkspaceIds();
        if (workspaceIds.length === 0) return;

        const apiKey = await anyApiKey(workspaceIds);
        let cursor = (await deps.repo.getState('ingestCursor')) ?? now - FIRST_WINDOW_S;
        let ingested = 0;

        for (let window = 0; window < MAX_WINDOWS_PER_TICK && cursor < now; window++) {
            const to = Math.min(now, cursor + WINDOW_S);
            const entries = await client.window(cursor, to, apiKey, INGEST_MAX_PAGES);
            await deps.repo.upsertMany(entries);
            cursor = to - OVERLAP_S;
            await deps.repo.setState('ingestCursor', cursor);
            ingested += entries.length;
        }

        await deps.repo.setState('ingestedAt', now);
        await purge(now);

        // Un tour qui n'a rien vu bouger ne reveille personne : chaque appel fait
        // re-solliciter tous les clients de l'espace.
        if (ingested === 0) return;
        deps.logger.info({ count: ingested }, 'CVE ingérées');
        for (const id of workspaceIds) deps.live.changed(id, ['cveFeed']);
    }

    const ticker = deps.createTicker({ intervalMs: TICK_MS, tick });
    return {
        start() {
            ticker.start();
            // Sans ce premier tour, le fil resterait vide une demi-heure après
            // l'installation. Lancé sans être attendu : le démarrage du serveur
            // n'a pas à dépendre de la disponibilité du NVD.
            void tick().catch((e: unknown) => {
                deps.logger.warn({ err: (e as Error).message }, 'Premier tour d’ingestion CVE échoué');
            });
        },
        stop: () => ticker.stop()
    };
}

import { CVE_LOOKUP_PROVIDER, type CveLookupHit, type CveLookupItem, type CveLookupProvider } from '@deveye/types/sdk';
import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { INGEST_MAX_PAGES, NVD_KEY_STORE_KEY } from './_shared';
import { nvdClient, type NvdClient } from './nvd';
import type { CveRepo } from './repo';
import { isAffected } from './versions';

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
/**
 * Combien de pages de rattrapage un tour demande, tous produits confondus. Un
 * produit suivi depuis vingt ans tient en une ou deux pages ; la borne garde
 * de la place dans le quota pour le fil et les recherches.
 */
const BACKFILL_PAGES_PER_TICK = 4;
/** Au-delà, le fil est réputé en retard et le catalogue ne garantit plus rien. */
const STALE_AFTER_S = 24 * 3600;

export function createService(deps: FeatureServiceDeps<CveRepo>, client: NvdClient = nvdClient): FeatureService {
    let lastPurgeAt = 0;
    let running = false;
    let stopping = false;
    let first: Promise<void> = Promise.resolve();

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

        // Le curseur est en base : un arrêt entre deux fenêtres ne perd rien.
        for (let window = 0; window < MAX_WINDOWS_PER_TICK && cursor < now && !stopping; window++) {
            const to = Math.min(now, cursor + WINDOW_S);
            const entries = await client.window(cursor, to, apiKey, INGEST_MAX_PAGES);
            await deps.repo.upsertMany(entries);
            cursor = to - OVERLAP_S;
            await deps.repo.setState('ingestCursor', cursor);
            ingested += entries.length;
        }

        await deps.repo.setState('ingestedAt', now);
        await backfill(apiKey);
        await purge(now);

        // Un tour qui n'a rien vu bouger ne reveille personne : chaque appel fait
        // re-solliciter tous les clients de l'espace.
        if (ingested === 0) return;
        deps.logger.info({ count: ingested }, 'CVE ingérées');
        for (const id of workspaceIds) deps.live.changed(id, ['cveFeed']);
    }

    /**
     * Le rattrapage des produits surveillés : toutes leurs CVE, une fois, par
     * pages. L'index avance en base : un tour interrompu reprend où il en était.
     */
    async function backfill(apiKey: string | null): Promise<void> {
        let pages = 0;
        for (const w of await deps.repo.listWatched()) {
            let index = w.backfill_index;
            while (w.backfilled_at === null && pages < BACKFILL_PAGES_PER_TICK && !stopping) {
                const page = await client.product(w.vendor, w.product, index, apiKey);
                await deps.repo.upsertMany(page.entries);
                pages++;
                index = page.next;
                if (page.done) {
                    await deps.repo.setBackfill(w.vendor, w.product, index, Math.floor(Date.now() / 1000));
                    break;
                }
                await deps.repo.setBackfill(w.vendor, w.product, index, null);
            }
            if (pages >= BACKFILL_PAGES_PER_TICK || stopping) return;
        }
    }

    const lookup: CveLookupProvider = {
        async watch(products) {
            const added = await deps.repo.watch(products, Math.floor(Date.now() / 1000));
            // Un produit neuf n'attend pas la demi-heure : son rattrapage part
            // tout de suite, sans retenir l'appelant.
            if (added > 0)
                void tick().catch((e: unknown) =>
                    deps.logger.warn({ err: (e as Error).message }, 'Rattrapage CVE échoué')
                );
        },
        async affecting(items) {
            const watched = new Map((await deps.repo.listWatched()).map((w) => [`${w.vendor}:${w.product}`, w]));
            const pending = [
                ...new Set(
                    items
                        .filter((i) => watched.get(`${i.vendor}:${i.product}`)?.backfilled_at == null)
                        .map((i) => i.product)
                )
            ];
            const ingestedAt = await deps.repo.getState('ingestedAt');
            const late = ingestedAt === null || Math.floor(Date.now() / 1000) - ingestedAt > STALE_AFTER_S;
            const hits: { item: CveLookupItem; cves: CveLookupHit[] }[] = [];
            const byProduct = new Map<string, Awaited<ReturnType<CveRepo['affecting']>>>();
            for (const item of items) {
                const key = `${item.vendor}:${item.product}`;
                if (!byProduct.has(key)) byProduct.set(key, await deps.repo.affecting(item.vendor, item.product));
                const seen = new Map<string, CveLookupHit>();
                for (const row of byProduct.get(key) ?? []) {
                    if (seen.has(row.cve_id) || !isAffected(item.version, row)) continue;
                    seen.set(row.cve_id, {
                        cveId: row.cve_id,
                        severity: row.severity,
                        score: row.score === null ? null : Number(row.score),
                        summary: row.summary,
                        published: Number(row.published),
                        fixedIn: row.end_excl
                    });
                }
                hits.push({ item, cves: [...seen.values()] });
            }
            const reason =
                pending.length > 0
                    ? `Le catalogue CVE rattrape encore l’historique de ${pending.join(', ')}.`
                    : late
                      ? 'Le catalogue CVE n’a pas été mis à jour depuis plus d’un jour.'
                      : null;
            return { status: reason === null ? 'ok' : 'stale', reason, hits };
        }
    };

    const ticker = deps.createTicker({ intervalMs: TICK_MS, tick });
    return {
        providers: { [CVE_LOOKUP_PROVIDER]: lookup },
        start() {
            stopping = false;
            ticker.start();
            // Sans ce premier tour, le fil resterait vide une demi-heure après
            // l'installation. Lancé sans être attendu : le démarrage du serveur
            // n'a pas à dépendre de la disponibilité du NVD.
            first = tick().catch((e: unknown) => {
                deps.logger.warn({ err: (e as Error).message }, 'Premier tour d’ingestion CVE échoué');
            });
        },
        async stop() {
            stopping = true;
            await Promise.all([ticker.stop(), first]);
        }
    };
}

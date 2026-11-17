import type { CveRepo } from '../repo';

/** Au-delà, le fil du NVD est réputé en retard et le catalogue ne garantit plus rien. */
const NVD_STALE_AFTER_S = 24 * 3600;

/**
 * Pourquoi le catalogue local du NVD ne peut pas encore répondre de ces
 * produits, ou `null` : un historique en cours de rattrapage, ou un fil qui
 * ne tourne plus. La veille le dit à côté de ses constats, la recherche à côté
 * des failles d'une version.
 */
export async function nvdStaleReason(
    repo: Pick<CveRepo, 'listWatched' | 'getState'>,
    products: readonly { vendor: string; product: string }[],
    now: number
): Promise<string | null> {
    const watched = new Map((await repo.listWatched()).map((w) => [`${w.vendor}:${w.product}`, w]));
    const filling = [
        ...new Set(
            products.filter((p) => watched.get(`${p.vendor}:${p.product}`)?.backfilled_at == null).map((p) => p.product)
        )
    ];
    if (filling.length > 0) return `Le catalogue du NVD rattrape encore l’historique de ${filling.join(', ')}.`;
    const ingestedAt = await repo.getState('ingestedAt');
    if (ingestedAt === null || now - ingestedAt > NVD_STALE_AFTER_S) {
        return 'Le catalogue du NVD n’a pas été mis à jour depuis plus d’un jour.';
    }
    return null;
}

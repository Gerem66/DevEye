import { startOfMonth } from '../contracts/calendar';
import type { InvoicingQuotaLine, InvoicingQuotaUsage } from '../contracts/domain';
import type { Quota } from './_shared';
import type { InvoicingRepo } from './repo';

/**
 * Ce que l'offre permet ce mois-ci, pour que l'écran le dise **avant** le refus.
 *
 * `assert` est la seule voie vers les espaces du propriétaire du compte, donc on
 * s'en sert pour lire le compteur en rendant `0`, qui ne fait rien refuser. Le
 * compte que l'écran annonce et celui que l'émission applique sont ainsi le même
 * appel de dépôt, et ils ne peuvent pas se contredire.
 */

/** Les deux clés du manifest, et le type de pièce que chacune compte. */
export const QUOTA_KEYS = { quote: 'quotesPerMonth', invoice: 'invoicesPerMonth' } as const;

async function lineOf(
    quota: Quota,
    repo: Pick<InvoicingRepo, 'countIssuedSince'>,
    key: string,
    kind: string,
    month: string
): Promise<InvoicingQuotaLine | null> {
    const limit = await quota.limit(key);
    if (limit === null) return null;

    let used = 0;
    await quota.assert(key, async (ownerWorkspaceIds) => {
        used = await repo.countIssuedSince(ownerWorkspaceIds, month, kind);
        return 0;
    });
    return { limit, used };
}

/** `null` : aucune des deux n'est bornée, donc il n'y a rien à annoncer. */
export async function monthUsage(
    quota: Quota,
    repo: Pick<InvoicingRepo, 'countIssuedSince'>,
    today: string
): Promise<InvoicingQuotaUsage | null> {
    const month = startOfMonth(today);
    const [quotes, invoices] = await Promise.all([
        lineOf(quota, repo, QUOTA_KEYS.quote, 'quote', month),
        lineOf(quota, repo, QUOTA_KEYS.invoice, 'invoice', month)
    ]);
    return quotes === null && invoices === null ? null : { quotes, invoices };
}

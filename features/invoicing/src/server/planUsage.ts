import { startOfMonth, todayIn } from '../contracts/calendar';
import { DEFAULT_SETTINGS } from '../contracts/defaults';
import type { InvoicingQuotaUsage } from '../contracts/domain';
import type { Quota } from './_shared';
import type { InvoicingRepo } from './repo';

/** Les deux clés du manifest, et le type de pièce que chacune compte. */
export const QUOTA_KEYS = { quote: 'quotesPerMonth', invoice: 'invoicesPerMonth' } as const;

/**
 * Ce qu'un compte a émis ce mois-ci, tous espaces confondus. Un compte peut
 * tenir des espaces de fuseaux différents : son mois est celui du fuseau par
 * défaut. Le refus, lui, compte depuis le mois de la date d'émission.
 */
export function issuedThisMonth(kind: 'quote' | 'invoice') {
    return (repo: InvoicingRepo, ownerWorkspaceIds: readonly number[]): Promise<number> =>
        repo.countIssuedSince(ownerWorkspaceIds, startOfMonth(todayIn(DEFAULT_SETTINGS.timeZone)), kind);
}

/** Ce que l'offre permet ce mois-ci, pour que l'écran le dise avant le refus. `null` : rien n'est borné. */
export async function monthUsage(quota: Quota): Promise<InvoicingQuotaUsage | null> {
    const [quotes, invoices] = await Promise.all([quota.usage(QUOTA_KEYS.quote), quota.usage(QUOTA_KEYS.invoice)]);
    return quotes === null && invoices === null ? null : { quotes, invoices };
}

import { createHmac, timingSafeEqual } from 'node:crypto';

import { OSINT_LOOKUP_QUOTA, type OsintTarget, type OsintUsage } from '../contracts/domain';
import type { SdkQuota, SdkServerKeys } from '@deveye/types/sdk/server';

import type { OsintRepo } from './repo';

/** AAAAMM en UTC, comme `ft_audience_usage` : le mois sur lequel la limite se compte. */
export function monthKey(nowMs: number = Date.now()): number {
    const d = new Date(nowMs);
    return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}

/**
 * Le ticket d'une cible : un HMAC de l'espace, du mois et de la cible, sous une
 * clé dérivée de celle du serveur. Il prouve à `osint.probe` que la recherche a
 * été comptée, sans rien garder de la cible côté serveur (l'historique, lui, est
 * chiffré par mot de passe). Il expire avec le mois.
 */
export function ticketFor(keys: SdkServerKeys, workspaceId: number, target: OsintTarget, month: number): string {
    return createHmac('sha256', keys.derive('osint.probe', 'ticket', 32))
        .update(`${workspaceId}|${month}|${target.kind}|${target.value}`)
        .digest('base64url');
}

export function ticketValid(
    keys: SdkServerKeys,
    workspaceId: number,
    target: OsintTarget,
    ticket: string,
    month: number
): boolean {
    const expected = Buffer.from(ticketFor(keys, workspaceId, target, month));
    const given = Buffer.from(ticket);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Les recherches du mois face à l'offre du propriétaire, `null` quand rien ne
 * les borne. `assert` est la seule voie vers ses espaces : on y lit le compte,
 * et le `0` rendu ne fait rien refuser. L'écran et le refus lisent ainsi le même.
 */
export async function lookupUsage(
    quota: SdkQuota,
    repo: Pick<OsintRepo, 'lookupsIn'>,
    month: number
): Promise<OsintUsage | null> {
    const limit = await quota.limit(OSINT_LOOKUP_QUOTA);
    if (limit === null) return null;
    let used = 0;
    await quota.assert(OSINT_LOOKUP_QUOTA, async (owned) => {
        used = await repo.lookupsIn(owned, month);
        return 0;
    });
    return { used, limit };
}

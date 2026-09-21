import { z } from 'zod';

import { CURRENCY_CODE } from '../contracts/domain';
import type { ConvertRepo } from './repo';

/**
 * Les taux de change : ceux que la Banque centrale européenne publie chaque
 * jour ouvré, contre l'euro, relus chez Frankfurter (sans clé ni compte).
 * L'adresse est fixe : aucune donnée d'un membre n'entre dans l'appel.
 */
const ENDPOINT = 'https://api.frankfurter.dev/v1/latest?base=EUR';
const FETCH_TIMEOUT_MS = 15_000;
/** Une source en panne n'est pas relancée à chaque tour d'entretien. */
const RETRY_SECONDS = 15 * 60;

const responseSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rates: z.record(z.string().regex(CURRENCY_CODE), z.number().positive())
});

export interface FxSnapshot {
    asOf: string;
    rates: Record<string, number>;
}

/** Point d'injection : les tests ne sortent jamais sur le réseau. */
export type FxClient = () => Promise<FxSnapshot>;

export const frankfurter: FxClient = async () => {
    const res = await fetch(ENDPOINT, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`La source des taux a répondu ${res.status}`);
    const parsed = responseSchema.parse(await res.json());
    return { asOf: parsed.date, rates: { ...parsed.rates, EUR: 1 } };
};

/** Relit les taux s'ils sont dus. Rend vrai quand de nouveaux taux ont été rangés. */
export async function refreshRates(
    repo: ConvertRepo,
    client: FxClient,
    at: number,
    refreshSeconds: number
): Promise<boolean> {
    const state = await repo.fxState();
    if (at - state.lastSuccessAt < refreshSeconds || at - state.lastAttemptAt < RETRY_SECONDS) return false;
    try {
        const snapshot = await client();
        await repo.saveRates(snapshot.asOf, snapshot.rates, at);
        await repo.markFxAttempt(at, true);
        return true;
    } catch (e) {
        await repo.markFxAttempt(at, false);
        throw e;
    }
}

/** Les derniers taux connus ne sont plus ceux du jour : la source n'a pas répondu depuis deux relectures. */
export function isStale(lastSuccessAt: number, at: number, refreshSeconds: number): boolean {
    return at - lastSuccessAt > refreshSeconds * 2;
}

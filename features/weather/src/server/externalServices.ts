import type { SdkExternalService, SdkExternalServicesContext } from '@deveye/types/sdk/server';

import { env } from './env';
import { probeOpenMeteo, WeatherError } from './provider';

/** Chaque lecture de la page compterait sinon dans le quota de l'abonnement. */
const MEMO_MS = 10 * 60_000;
let memo: { at: number; value: SdkExternalService } | null = null;

async function openMeteo(): Promise<SdkExternalService> {
    const base = { id: 'open-meteo', name: 'Open-Meteo' };
    if (!env.OPEN_METEO_API_KEY) {
        return {
            ...base,
            state: 'inactive',
            summary: 'Sans OPEN_METEO_API_KEY : la météo passe par le palier gratuit, réservé au non commercial.'
        };
    }
    const facts = [{ label: 'Accès', value: 'Abonnement (hôtes customer-)' }];
    try {
        await probeOpenMeteo();
        return { ...base, state: 'ok', summary: 'La clé est acceptée.', facts };
    } catch (e) {
        const reason = e instanceof WeatherError ? e.reason : null;
        return {
            ...base,
            state: reason === 'rate_limited' ? 'degraded' : 'down',
            summary:
                reason === 'misconfigured'
                    ? 'Open-Meteo refuse la clé.'
                    : reason === 'rate_limited'
                      ? 'Le quota de l’abonnement est atteint.'
                      : 'Open-Meteo ne répond pas.',
            facts
        };
    }
}

export async function weatherExternalServices({
    refresh
}: SdkExternalServicesContext): Promise<readonly SdkExternalService[]> {
    if (refresh || !memo || Date.now() - memo.at > MEMO_MS) memo = { at: Date.now(), value: await openMeteo() };
    return [memo.value];
}

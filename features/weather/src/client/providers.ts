import { WsError } from 'deveye-sdk-client';

import { providerNeedsKey, weatherProviderSchema, type WeatherProvider } from '../contracts/domain';

/** Ce que chaque fournisseur montre de lui, dans la fiche comme dans le panneau Sources. */
export const PROVIDER_META: Record<WeatherProvider, { label: string; hint: string; signupUrl?: string }> = {
    'open-meteo': {
        label: 'Open-Meteo',
        hint: 'Gratuit et sans clé : le fournisseur par défaut, rien à régler.'
    },
    openweathermap: {
        label: 'OpenWeatherMap',
        hint: 'Exige une clé d’API, gratuite à créer.',
        signupUrl: 'https://openweathermap.org/api'
    }
};

/**
 * Les fournisseurs qu'une ville peut choisir : les libres, et ceux dont l'espace
 * tient la clé. Le serveur refuse les autres, et en retire ses villes quand leur
 * clé part.
 */
export function selectableProviders(held: Record<string, boolean>): WeatherProvider[] {
    return weatherProviderSchema.options.filter((p) => !providerNeedsKey(p) || held[p] === true);
}

/**
 * L'échec d'un fournisseur tel que le serveur le nomme : sa raison et sa phrase,
 * déjà en français. `null` pour tout autre échec (socket, délai), dont le texte
 * n'est pas fait pour l'écran.
 */
export function providerFailure(e: unknown): { reason: string; message: string } | null {
    if (!(e instanceof WsError)) return null;
    const reason = (e.details as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' ? { reason, message: e.message } : null;
}

/** La clé refusée : le seul échec qui périme un relevé déjà affiché. */
export function isKeyRefused(e: unknown): boolean {
    return providerFailure(e)?.reason === 'unauthorized';
}

import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/** Les variables d'environnement de la feature se lisent ici, pas dans `Utils/Env`. */
export const WEATHER_ENV = defineModuleEnv({
    /**
     * La clé de l'abonnement Open-Meteo de l'instance. Son palier gratuit est
     * réservé à l'usage non commercial : une instance qui vend des abonnements
     * la pose, et les appels passent alors par les hôtes `customer-`.
     */
    OPEN_METEO_API_KEY: { kind: 'secret' }
});

export const env = readModuleEnv(WEATHER_ENV).values;

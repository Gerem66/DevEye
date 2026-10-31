/**
 * Le temps que chaque fonctionnalité passe à servir (commandes du dispatcheur,
 * tâches de fond des modules), cumulé en mémoire seulement pendant qu'une
 * montée en charge l'écoute : sans écoute, il ne coûte qu'une vérification.
 * Du temps écoulé, attente de la base comprise, pas du CPU.
 */

export interface FeatureTime {
    calls: number;
    ms: number;
}

export function createFeatureLoad(now: () => number = () => performance.now()) {
    let totals: Map<string, FeatureTime> | null = null;

    const add = (key: string, ms: number): void => {
        if (!totals) return;
        const entry = totals.get(key);
        if (entry) {
            entry.calls++;
            entry.ms += ms;
        } else totals.set(key, { calls: 1, ms });
    };

    return {
        /** `fn` au compte de `key` ; un échec compte aussi, il a occupé le serveur. */
        async time<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
            if (!totals) return fn();
            const started = now();
            try {
                return await fn();
            } finally {
                add(key, now() - started);
            }
        },

        /** Une seule écoute à la fois : la montée en charge, que le registre des essais rend unique. */
        watch() {
            totals = new Map();
            return {
                /** Le cumul depuis la lecture précédente. */
                drain(): Map<string, FeatureTime> {
                    if (!totals) return new Map();
                    const out = totals;
                    totals = new Map();
                    return out;
                },
                stop(): void {
                    totals = null;
                }
            };
        }
    };
}

export const featureLoad = createFeatureLoad();

/**
 * Ce que le processus sait de la santé de chaque module, en mémoire : ses
 * tâches de fond qui échouent d'affilée, et ses commandes qui plantent. La
 * page d'état le lit par `Services/statusProbe.ts`. Aucune écriture, aucun
 * appel : tenu au fil de l'eau par le ticker du SDK et le dispatcheur.
 */

/** Échecs d'affilée d'une même tâche de fond avant de dire le module dégradé. */
export const TICK_FAILURES_DEGRADED = 3;
/** La fenêtre et le seuil des commandes qui plantent (erreur interne, pas un refus). */
export const COMMAND_WINDOW_MS = 5 * 60_000;
export const COMMAND_FAILURES_DEGRADED = 5;

export type FeatureHealthState = 'up' | 'degraded';

export interface FeatureHealthReport {
    state: FeatureHealthState;
    /** La cause, en mots du public : jamais une pile ni un nom de commande. */
    reason: string | null;
}

export function createFeatureHealth(now: () => number = Date.now) {
    // Une entrée par tâche de fond : un module en tient plusieurs (sonde et purge).
    const ticks = new Map<string, Map<symbol, number>>();
    const commands = new Map<string, number[]>();

    const recentCommandFailures = (featureId: string, at: number): number[] => {
        const kept = (commands.get(featureId) ?? []).filter((t) => at - t < COMMAND_WINDOW_MS);
        if (kept.length === 0) commands.delete(featureId);
        else commands.set(featureId, kept);
        return kept;
    };

    return {
        /** Le suivi d'une tâche de fond, à tenir pour toute sa vie. */
        ticker(featureId: string) {
            const key = Symbol(featureId);
            const set = (value: number | null): void => {
                let entries = ticks.get(featureId);
                if (value === null) {
                    entries?.delete(key);
                    if (entries?.size === 0) ticks.delete(featureId);
                    return;
                }
                if (!entries) ticks.set(featureId, (entries = new Map()));
                entries.set(key, value);
            };
            return {
                succeeded: () => set(0),
                failed: () => set((ticks.get(featureId)?.get(key) ?? 0) + 1),
                /** Une tâche arrêtée (maintenance) ne compte plus : elle n'échoue pas, elle dort. */
                forget: () => set(null)
            };
        },
        commandFailed(featureId: string): void {
            const at = now();
            commands.set(featureId, [...recentCommandFailures(featureId, at), at].slice(-COMMAND_FAILURES_DEGRADED));
        },
        of(featureId: string): FeatureHealthReport {
            const failing = [...(ticks.get(featureId)?.values() ?? [])].some((n) => n >= TICK_FAILURES_DEGRADED);
            if (failing) return { state: 'degraded', reason: 'Tâches de fond en échec' };
            if (recentCommandFailures(featureId, now()).length >= COMMAND_FAILURES_DEGRADED) {
                return { state: 'degraded', reason: 'Erreurs à répétition' };
            }
            return { state: 'up', reason: null };
        }
    };
}

export const featureHealth = createFeatureHealth();

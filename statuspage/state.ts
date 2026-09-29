/**
 * Ce que la page d'état retient de chaque composant, et comment une mesure le
 * fait évoluer. Pur : ni horloge, ni base, ni réseau.
 */

/** `maintenance` est une indisponibilité : elle compte contre la disponibilité. */
export type ComponentState = 'up' | 'degraded' | 'down' | 'maintenance';
export type ComponentKind = 'app' | 'public' | 'feature';

/** Mesures en échec d'affilée avant de déclarer une panne : un raté isolé n'en est pas une. */
export const FAILURE_STREAK = 2;

export interface Tracked {
    /** `null` tant que rien n'est confirmé (premier passage, retour après un trou). */
    state: ComponentState | null;
    /** Depuis quand l'état tient, daté de la première mesure qui l'a montré. */
    since: number | null;
    /** La cause, en mots du public. */
    reason: string | null;
    /** Le message de maintenance que DevEye affiche. */
    message: string | null;
    /** Hérité de l'app : une fonctionnalité ne répond pas quand DevEye ne répond pas. */
    inherited: boolean;
    /** Un état pire que l'actuel, vu mais pas encore confirmé. */
    pending: ComponentState | null;
    pendingSince: number | null;
    streak: number;
}

export interface Observation {
    state: ComponentState;
    reason: string | null;
    message: string | null;
}

export interface Transition {
    from: ComponentState | null;
    to: ComponentState;
    at: number;
    inherited: boolean;
}

export const UNKNOWN: Tracked = {
    state: null,
    since: null,
    reason: null,
    message: null,
    inherited: false,
    pending: null,
    pendingSince: null,
    streak: 0
};

/**
 * Une panne ou une perturbation qui s'aggrave attend sa confirmation ; la
 * maintenance, annoncée par DevEye lui-même, et toute amélioration s'appliquent
 * aussitôt.
 */
function needsConfirmation(next: ComponentState, current: ComponentState | null): boolean {
    return next === 'down' || (next === 'degraded' && current !== 'down');
}

/** La mesure suivante d'un composant qui a sa propre sonde. */
export function advance(
    current: Tracked,
    seen: Observation,
    now: number
): { next: Tracked; transition: Transition | null } {
    if (seen.state === current.state && !current.inherited) {
        return {
            next: {
                ...current,
                reason: seen.reason,
                message: seen.message,
                pending: null,
                pendingSince: null,
                streak: 0
            },
            transition: null
        };
    }
    if (needsConfirmation(seen.state, current.state)) {
        const same = current.pending === seen.state;
        const streak = same ? current.streak + 1 : 1;
        const pendingSince = same && current.pendingSince !== null ? current.pendingSince : now;
        if (streak < FAILURE_STREAK) {
            // L'état hérité ne tient plus (l'app répond) : rien de confirmé en attendant.
            const base = current.inherited ? UNKNOWN : current;
            return { next: { ...base, pending: seen.state, pendingSince, streak }, transition: null };
        }
        return commit(current, seen, pendingSince, false);
    }
    return commit(current, seen, now, false);
}

/** L'état de l'app imposé à une fonctionnalité : déjà confirmé, il s'applique tel quel. */
export function inherit(
    current: Tracked,
    app: Observation,
    now: number
): { next: Tracked; transition: Transition | null } {
    if (current.inherited && current.state === app.state) {
        return { next: { ...current, reason: app.reason, message: app.message }, transition: null };
    }
    return commit(current, app, now, true);
}

function commit(
    current: Tracked,
    seen: Observation,
    at: number,
    inherited: boolean
): { next: Tracked; transition: Transition } {
    return {
        next: {
            state: seen.state,
            since: at,
            reason: seen.reason,
            message: seen.message,
            inherited,
            pending: null,
            pendingSince: null,
            streak: 0
        },
        transition: { from: current.state, to: seen.state, at, inherited }
    };
}

import type { ProbeResult } from './probe';
import { advance, inherit, UNKNOWN, type Observation, type Tracked, type Transition } from './state';
import type { ComponentRow, Store } from './store';

/**
 * Le passage périodique : mesurer, faire évoluer chaque composant, compter la
 * journée, ouvrir et fermer les incidents. La page ne lit que ce qui est écrit
 * ici.
 */

export const APP_ID = 'deveye';
export const PUBLIC_ID = 'public';
export const APP_LABEL = 'Application DevEye';
export const PUBLIC_LABEL = 'Pages publiques';
/** Au-delà de ces intervalles sans passage, la page d'état était arrêtée : on ne sait rien de ce temps-là. */
export const GAP_INTERVALS = 3;

export interface ComponentChange {
    component: Pick<ComponentRow, 'id' | 'label' | 'kind'>;
    next: Tracked;
    transition: Transition;
}

export interface MonitorDeps {
    store: Store;
    probe(): Promise<ProbeResult>;
    intervalSeconds: number;
    /** Appelé après l'écriture, pour chaque composant qui a changé d'état. */
    onChange(change: ComponentChange): void;
    warn(message: string): void;
    now?: () => number;
}

const LAST_TICK = 'last_tick';
const LAST_PRUNE = 'last_prune';

export function createMonitor(deps: MonitorDeps) {
    const { store } = deps;
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    let warnedRefusal = false;

    /** Le temps où la page d'état était arrêtée ne compte ni pour ni contre DevEye. */
    const closeGap = (last: number): void => {
        const endedAt = last + deps.intervalSeconds;
        for (const c of store.components()) {
            store.closeIncident(c.id, endedAt);
            store.track(c.id, UNKNOWN);
        }
    };

    const apply = (
        row: ComponentRow,
        step: { next: Tracked; transition: Transition | null },
        at: number,
        changes: ComponentChange[]
    ): void => {
        store.track(row.id, step.next);
        const t = step.transition;
        if (t) {
            store.closeIncident(row.id, t.at);
            // Un état hérité a déjà son incident, sur l'app : le recopier doublerait l'historique.
            if (t.to !== 'up' && !t.inherited)
                store.openIncident(row.id, t.to, step.next.reason, step.next.message, t.at);
            changes.push({ component: row, next: step.next, transition: t });
        }
        if (step.next.state !== null) store.count(row.id, step.next.state, at);
    };

    async function tick(): Promise<void> {
        const at = now();
        const result = await deps.probe();
        if (result.refused && !warnedRefusal) {
            warnedRefusal = true;
            deps.warn('DevEye refuse le jeton (STATUS_PROBE_TOKEN) : l’état des fonctionnalités n’est pas mesuré.');
        }

        const changes: ComponentChange[] = [];
        /** Un composant mesuré ; l'état de l'app, quand elle ne répond pas, l'emporte sur sa mesure. */
        const step = (id: string, seen: Observation, global: Observation | null): Tracked => {
            const row = store.component(id)!;
            apply(row, global ? inherit(row, global, at) : advance(row, seen, at), at, changes);
            return store.component(id)!;
        };

        store.tx(() => {
            const last = Number(store.meta(LAST_TICK) ?? 0);
            if (last > 0 && at - last > GAP_INTERVALS * deps.intervalSeconds) closeGap(last);

            store.declare(APP_ID, APP_LABEL, 'app', 0);
            const app = step(APP_ID, result.app, null);
            const global: Observation | null =
                app.state === 'down' || app.state === 'maintenance'
                    ? { state: app.state, reason: app.reason, message: app.message }
                    : null;

            if (result.public) {
                store.declare(PUBLIC_ID, PUBLIC_LABEL, 'public', 1);
                step(PUBLIC_ID, result.public, global);
            } else {
                store.unlistExcept('public', []);
            }

            if (result.features) {
                result.features.forEach((f, i) => store.declare(f.id, f.label, 'feature', 10 + i));
                store.unlistExcept(
                    'feature',
                    result.features.map((f) => f.id)
                );
                for (const f of result.features) {
                    step(f.id, { state: f.state, reason: f.reason, message: null }, global);
                }
            } else if (global) {
                // Sans relevé, les modules connus suivent quand même l'app qui ne répond plus.
                for (const c of store.components()) {
                    if (c.kind === 'feature' && c.listed) apply(c, inherit(c, global, at), at, changes);
                }
            }
            store.setMeta(LAST_TICK, String(at));
        });

        for (const change of changes) deps.onChange(change);

        const pruned = Number(store.meta(LAST_PRUNE) ?? 0);
        if (at - pruned >= 86_400) {
            store.prune(at);
            store.setMeta(LAST_PRUNE, String(at));
        }
    }

    return {
        tick,
        /** Le dernier passage réussi, pour la sonde de vie du conteneur. */
        lastTick: (): number => Number(store.meta(LAST_TICK) ?? 0)
    };
}

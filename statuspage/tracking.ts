import { statusTrackingSchema, type StatusTracking } from '../src/Services/statusProbeContract';
import type { Store } from './store';

/**
 * La balise Audience de la page, lue chez DevEye au même rythme que les
 * destinations des alertes et gardée ici : quand DevEye ne répond plus, la
 * page garde la dernière connue, et le script absent échoue en silence comme
 * n'importe quel script tiers. Rien à régler dans l'env de la page : c'est la
 * page Tests et débogage de l'app qui déclare son site.
 */

const TRACKING_KEY = 'tracking';

export interface TrackingDeps {
    store: Store;
    fetchTracking(): Promise<unknown>;
}

export function createTracking(deps: TrackingDeps) {
    return {
        current(): StatusTracking {
            const raw = deps.store.meta(TRACKING_KEY);
            if (!raw) return null;
            try {
                const parsed = statusTrackingSchema.shape.tracking.safeParse(JSON.parse(raw));
                return parsed.success ? parsed.data : null;
            } catch {
                return null;
            }
        },

        /** Relue tant que DevEye répond ; un retrait chez lui (`null`) retire la balise ici aussi. */
        async refresh(): Promise<void> {
            try {
                const parsed = statusTrackingSchema.safeParse(await deps.fetchTracking());
                if (!parsed.success) return;
                const { tracking } = parsed.data;
                // L'origine entre dans la politique de sécurité de la page : rien
                // d'autre que le schéma et l'hôte ne doit y entrer.
                const held = tracking ? { key: tracking.key, origin: new URL(tracking.origin).origin } : null;
                deps.store.setMeta(TRACKING_KEY, JSON.stringify(held));
            } catch {
                // DevEye ne répond pas : la balise déjà connue reste.
            }
        }
    };
}

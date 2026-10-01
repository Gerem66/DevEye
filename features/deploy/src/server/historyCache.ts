import type { RemoteDeployment } from './providers/types';

/** Durée pendant laquelle un historique relu sert à retrouver un journal. */
const TTL_MS = 5 * 60_000;
/** Cibles retenues au plus : au-delà, la plus ancienne s'efface. */
const MAX_TARGETS = 200;

const remembered = new Map<number, { at: number; rows: readonly RemoteDeployment[] }>();

/**
 * L'historique que le client vient de lister, par cible : `deploy.log` y
 * retrouve la référence du journal sans refaire l'aller-retour chez le
 * fournisseur, qui était le temps d'ouverture de la popup. La référence d'un
 * déploiement ne change pas ; la durée ne borne que la mémoire.
 */
export function rememberHistory(targetId: number, rows: readonly RemoteDeployment[], now = Date.now()): void {
    // Réinséré en queue : l'ordre d'insertion de la Map est l'ordre d'éviction.
    remembered.delete(targetId);
    remembered.set(targetId, { at: now, rows });
    while (remembered.size > MAX_TARGETS) {
        const oldest = remembered.keys().next().value;
        if (oldest === undefined) break;
        remembered.delete(oldest);
    }
}

/** L'entrée d'un historique encore frais, ou `null` : à relire chez le fournisseur. */
export function recallHistoryEntry(targetId: number, externalId: string, now = Date.now()): RemoteDeployment | null {
    const known = remembered.get(targetId);
    if (!known) return null;
    if (now - known.at > TTL_MS) {
        remembered.delete(targetId);
        return null;
    }
    return known.rows.find((row) => row.externalId === externalId) ?? null;
}

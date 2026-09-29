import type { SdkServiceHealth } from '@deveye/types/sdk/server';

import type { ListenerState } from '../../contracts/domain';

/** Ce que chaque port fermé coûte aux utilisateurs, dans leurs mots. */
const LOST: Record<ListenerState['name'], string> = {
    smtp: 'Réception des e-mails interrompue',
    imaps: 'Consultation des boîtes indisponible',
    submissions: 'Envoi depuis un logiciel de messagerie indisponible',
    submission: 'Envoi depuis un logiciel de messagerie indisponible'
};

/**
 * La santé du serveur mail d'après ses ports : aucun ouvert, il est hors
 * service ; certains, il est dégradé. Un envoi reste possible tant que l'un des
 * deux ports de soumission répond.
 */
export function listenersHealth(listeners: readonly ListenerState[]): SdkServiceHealth {
    if (listeners.length === 0) return { state: 'up' };
    if (listeners.every((l) => !l.up)) return { state: 'down', reason: 'Serveur mail injoignable' };
    const submitting = listeners.some((l) => l.up && (l.name === 'submission' || l.name === 'submissions'));
    const closed = listeners.find((l) => !l.up && (submitting ? l.name === 'smtp' || l.name === 'imaps' : true));
    return closed ? { state: 'degraded', reason: LOST[closed.name] } : { state: 'up' };
}

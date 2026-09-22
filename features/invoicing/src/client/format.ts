import { daysBetween } from '../contracts/calendar';
import type { DocumentKind } from '../contracts/domain';
import type { DisplayStatus } from '../contracts/status';

/** Le vocabulaire de l'interface. Les mises en forme partagées viennent des contrats. */
export * from '../contracts/display';
import { todayIso } from '../contracts/display';

/**
 * Le mot de l'état, accordé. « Envoyé » pour une facture serait du français
 * bâclé : un devis et un avoir sont masculins, une facture est féminine, et le
 * même état ne se dit pas pareil pour une facture (« à payer ») et pour un avoir
 * (« émis »).
 */
export function statusLabel(kind: DocumentKind, status: DisplayStatus): string {
    if (status === 'draft') return 'Brouillon';
    if (kind === 'quote') {
        if (status === 'accepted') return 'Accepté';
        if (status === 'declined') return 'Refusé';
        if (status === 'expired') return 'Expiré';
        return 'Envoyé';
    }
    if (kind === 'credit') return 'Émis';
    if (status === 'paid') return 'Payée';
    if (status === 'partial') return 'Payée en partie';
    if (status === 'late') return 'En retard';
    if (status === 'cancelled') return 'Annulée';
    return 'À payer';
}

/** La couleur ne dit jamais seule : le badge porte toujours le mot. */
export const STATUS_TONE: Record<DisplayStatus, 'success' | 'warning' | 'danger' | 'accent' | 'neutral'> = {
    draft: 'neutral',
    sent: 'accent',
    issued: 'accent',
    accepted: 'success',
    declined: 'danger',
    expired: 'warning',
    partial: 'warning',
    paid: 'success',
    late: 'danger',
    cancelled: 'neutral'
};

/** Le jour d'un horodatage en secondes, dans le fuseau de qui regarde l'écran. */
export function formatMoment(at: number): string {
    return new Date(at * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Ce qui presse, en toutes lettres à côté du badge : la couleur dit l'état,
 * cette phrase dit ce qu'il coûte d'attendre.
 */
export function deadlineNote(status: DisplayStatus, dueOn: string | null, validUntil: string | null): string | null {
    const day = status === 'expired' || status === 'sent' ? validUntil : dueOn;
    if (day === null) return null;
    const days = daysBetween(todayIso(), day);

    if (status === 'late') return `en retard de ${days === -1 ? 'un jour' : `${-days} jours`}`;
    if (status === 'expired') return `expiré depuis ${days === -1 ? 'un jour' : `${-days} jours`}`;
    if (days < 0) return null;
    if (days === 0) return "c'est aujourd'hui";
    if (days === 1) return 'demain';
    if (days <= 14) return `dans ${days} jours`;
    return null;
}

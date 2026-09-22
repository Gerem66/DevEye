import { isExpired, isOverdue } from './calendar';
import type { DocumentKind, DocumentStatus } from './domain';

/**
 * Le statut **affiché**, qui n'est pas celui qui est stocké. « En retard »,
 * « payée » et « expiré » sont des fonctions des dates, des sommes et du jour
 * courant : les stocker demanderait une tâche de fond pour faire passer minuit,
 * et une facture réglée hier resterait en retard jusqu'à ce que quelqu'un
 * repasse derrière.
 *
 * Cette fonction est partagée par le client et le serveur, et le dépôt écrit le
 * même prédicat en SQL pour filtrer « en retard » : deux règles divergentes
 * seraient un bug garanti.
 */
export type DisplayStatus =
    'draft' | 'sent' | 'issued' | 'accepted' | 'declined' | 'expired' | 'partial' | 'paid' | 'late' | 'cancelled';

export interface StatusInput {
    kind: DocumentKind;
    status: DocumentStatus;
    dueOn: string | null;
    validUntil: string | null;
    /** Le total TTC figé à l'émission ; `null` pour un brouillon. */
    grossCents: number | null;
    /** Règlements, avoirs et acomptes déduits, additionnés. */
    settledCents: number;
}

/**
 * Ordre de préséance : annulé, puis payé, puis en retard, puis payé en partie,
 * puis expiré, puis le statut stocké.
 */
export function effectiveStatus(doc: StatusInput, today: string): DisplayStatus {
    if (doc.status === 'cancelled') return 'cancelled';
    if (doc.status === 'draft') return 'draft';

    if (doc.kind === 'quote') {
        if (doc.status === 'accepted' || doc.status === 'declined') return doc.status;
        return isExpired(doc.validUntil, today) ? 'expired' : 'sent';
    }

    // Un avoir ne s'encaisse pas : il éteint une créance ailleurs.
    if (doc.kind === 'credit') return 'issued';

    const gross = doc.grossCents ?? 0;
    if (gross > 0 && doc.settledCents >= gross) return 'paid';
    if (isOverdue(doc.dueOn, today)) return 'late';
    if (doc.settledCents > 0) return 'partial';
    return 'issued';
}

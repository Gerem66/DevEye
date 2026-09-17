import type { AuthVerdict, MailEventKind } from '../contracts/domain';

export const EVENT_LABEL: Record<MailEventKind, string> = {
    received: 'Reçu',
    junked: 'Indésirable',
    rejected: 'Refusé',
    sent: 'Envoyé',
    deferred: 'Reporté',
    bounced: 'Non remis',
    login: 'Connexion',
    login_failed: 'Connexion refusée'
};

export const EVENT_TONE: Record<MailEventKind, 'success' | 'warning' | 'danger' | 'neutral' | 'accent'> = {
    received: 'success',
    junked: 'warning',
    rejected: 'danger',
    sent: 'accent',
    deferred: 'warning',
    bounced: 'danger',
    login: 'neutral',
    login_failed: 'danger'
};

export const VERDICT_LABEL: Record<AuthVerdict, string> = { pass: 'oui', fail: 'non', none: '·' };

/** « il y a 3 min », « hier », puis la date : ce qu'on lit d'un coup d'œil sur une fiche. */
export function ago(ts: number | null): string {
    if (ts === null) return 'jamais';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (seconds < 60) return 'à l’instant';
    if (seconds < 3_600) return `il y a ${Math.floor(seconds / 60)} min`;
    if (seconds < 86_400) return `il y a ${Math.floor(seconds / 3_600)} h`;
    if (seconds < 2 * 86_400) return 'hier';
    return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const clock = (ts: number): string =>
    new Date(ts * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });

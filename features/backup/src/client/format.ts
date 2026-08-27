import type {
    BackupDestinationKind,
    BackupDestinationStatus,
    BackupRunStatus,
    BackupScheduleKind,
    BackupSourceKind
} from '../contracts/domain';

/** Le vocabulaire de la feature, un seul jeu pour tous ses écrans. */
export const DESTINATION_LABELS: Record<BackupDestinationKind, string> = {
    local: 'Dossier du serveur',
    device: 'Dossier d’une machine',
    s3: 'Serveur S3'
};

export const DESTINATION_ICONS: Record<BackupDestinationKind, string> = {
    local: 'server',
    device: 'cpu',
    s3: 'cloud'
};

export const SOURCE_LABELS: Record<BackupSourceKind, string> = {
    deveye: 'Base de DevEye',
    database: 'Base de données',
    cloudsync: 'Partage CloudSync'
};

export const SCHEDULE_LABELS: Record<BackupScheduleKind, string> = {
    manual: 'Manuelle',
    hourly: 'Toutes les heures',
    daily: 'Chaque jour',
    weekly: 'Chaque semaine',
    monthly: 'Chaque mois'
};

export const RUN_LABELS: Record<BackupRunStatus, string> = {
    running: 'En cours',
    success: 'Réussie',
    failed: 'Échouée'
};

export const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/**
 * La teinte d'un état.
 *
 * « En cours » reste neutre et non colorée : c'est l'état normal d'une
 * sauvegarde qui vient de partir, et la peindre ferait passer un travail en
 * cours pour un incident — même règle que Déploiement et Bases de données.
 */
export function runTone(status: BackupRunStatus | null): 'neutral' | 'online' | 'danger' {
    if (status === 'success') return 'online';
    if (status === 'failed') return 'danger';
    return 'neutral';
}

export function destinationTone(status: BackupDestinationStatus): 'neutral' | 'online' | 'danger' {
    if (status === 'ok') return 'online';
    if (status === 'error') return 'danger';
    return 'neutral';
}

/** « il y a 3 min » — la même échelle que les autres features. */
export function formatAgo(at: number | null, never = 'jamais'): string {
    if (at === null) return never;
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - at);
    if (seconds < 60) return 'à l’instant';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

/** « dans 4 h » — l'échelle inverse, pour une échéance. */
export function formatIn(at: number | null): string {
    if (at === null) return 'aucune';
    const seconds = at - Math.floor(Date.now() / 1000);
    if (seconds <= 0) return 'imminente';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `dans ${Math.max(1, minutes)} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `dans ${hours} h`;
    return `dans ${Math.floor(hours / 24)} j`;
}

/** Date et heure complètes, pour un historique où l'ordre exact compte. */
export function formatMoment(at: number): string {
    return new Date(at * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/** La cadence d'un travail, en une phrase. */
export function describeSchedule(job: {
    schedule: BackupScheduleKind;
    scheduleHour: number;
    scheduleWeekday: number;
    scheduleDay: number;
}): string {
    const hour = `${String(job.scheduleHour).padStart(2, '0')} h`;
    switch (job.schedule) {
        case 'manual':
            return 'Sur demande uniquement';
        case 'hourly':
            return 'Toutes les heures';
        case 'daily':
            return `Chaque jour à ${hour}`;
        case 'weekly':
            return `Chaque ${WEEKDAYS[job.scheduleWeekday]} à ${hour}`;
        case 'monthly':
            return `Le ${job.scheduleDay} de chaque mois à ${hour}`;
    }
}

/**
 * Budget client pour les commandes qui parlent à un tiers.
 *
 * `backup.destinationTest` écrit puis relit puis efface un objet témoin sur un
 * service qui peut être au bout d'un VPN : le défaut de la socket (15 s) est
 * trop court, et abandonner avant le serveur ferait afficher « échec » là où le
 * contrôle est simplement lent.
 */
export const BACKUP_PROBE_TIMEOUT_MS = 60_000;

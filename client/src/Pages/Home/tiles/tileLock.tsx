import { StatusBadge } from '@/Components/StatusBadge';

/**
 * Pourquoi une carte reste en retrait : le rôle ne l'ouvre pas, la feature est
 * en maintenance, ou arrêtée (ce que seul un administrateur lit ainsi).
 */
export type TileLock = 'rights' | 'maintenance' | 'stopped';

export const LOCK_TEXT: Record<TileLock, string> = {
    rights: 'Accès restreint',
    maintenance: 'En maintenance',
    stopped: 'Arrêt complet'
};

/** La pastille d'une feature ouverte au seul administrateur, le temps de sa maintenance. */
export const MAINTENANCE_BADGE = (
    <StatusBadge tone='warning' dot={false}>
        Maintenance
    </StatusBadge>
);

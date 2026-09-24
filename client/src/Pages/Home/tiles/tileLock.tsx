import type { ReactNode } from 'react';

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

/** Pourquoi une feature fermée aux autres comptes reste ouverte à l'administrateur qui la regarde. */
export type AdminBadge = 'maintenance' | 'preview';

export const ADMIN_BADGE: Record<AdminBadge, ReactNode> = {
    maintenance: (
        <StatusBadge tone='warning' dot={false}>
            Maintenance
        </StatusBadge>
    ),
    preview: (
        <StatusBadge tone='accent' dot={false}>
            Préversion
        </StatusBadge>
    )
};

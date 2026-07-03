import type { CloudSyncShareState } from 'deveye-types';
import styles from './style.module.css';

/**
 * Apparence d'un état de partage — partagée par le héros et le widget. Le
 * dessin lui-même vit dans {@link HeroIcon} (SVG inline) ; ici seuls le libellé
 * et la classe de couleur.
 */
export interface StateLook {
    badgeClass: string;
    label: string;
}

const LOOKS: Record<CloudSyncShareState['state'], StateLook> = {
    synced: { badgeClass: styles.heroSynced, label: 'Synchronisé' },
    syncing: { badgeClass: styles.heroSyncing, label: 'Synchronisation…' },
    paused: { badgeClass: styles.heroPaused, label: 'En pause' },
    offline: { badgeClass: styles.heroOffline, label: 'Appareil hors ligne' },
    error: { badgeClass: styles.heroError, label: 'Erreur' }
};

export function stateLook(state: CloudSyncShareState['state']): StateLook {
    return LOOKS[state];
}

/** L'état agrégé de plusieurs partages : le plus « grave » l'emporte. */
export function aggregateState(states: ReadonlyArray<CloudSyncShareState['state']>): CloudSyncShareState['state'] {
    const order: CloudSyncShareState['state'][] = ['error', 'syncing', 'offline', 'paused', 'synced'];
    for (const candidate of order) {
        if (states.includes(candidate)) return candidate;
    }
    return 'synced';
}

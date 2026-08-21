import type { WorkspaceFeatureId } from 'deveye-types';

import MailSyncPanel from '@/Features/Mail/MailSyncPanel';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * La **synchronisation** d'un élément : à quel rythme il se relève, et sa
 * maintenance. À l'échelle d'un élément seulement : c'est chaque boîte qui a
 * sa cadence, pas la fonctionnalité.
 *
 * Même patron que `SourcesSection` : la table dit qui est branché, le panneau
 * est autonome, chemins d'import directs (jamais le baril, cycle).
 */
export const SYNC_WIRED: Partial<Record<WorkspaceFeatureId, true>> = {
    mail: true
};

export default function SyncSection({ scope }: { scope: SettingsScope }) {
    if (scope.kind !== 'item') return null;
    return (
        <div className={styles.section}>{scope.feature === 'mail' && <MailSyncPanel accountId={scope.itemId} />}</div>
    );
}

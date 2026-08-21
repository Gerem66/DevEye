import type { WorkspaceFeatureId } from 'deveye-types';

import MailEncryptionPanel from '@/Features/Mail/MailEncryptionPanel';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Le **chiffrement** d'un élément : sous quelle clé sa donnée vit, quand la
 * fonctionnalité laisse le choix. À l'échelle d'un élément seulement : c'est
 * chaque boîte, chaque travail de sauvegarde qui choisit, pas la
 * fonctionnalité.
 *
 * Même patron que `SourcesSection` : la table dit qui est branché, le panneau
 * est autonome, chemins d'import directs (jamais le baril, cycle).
 */
export const ENCRYPTION_WIRED: Partial<Record<WorkspaceFeatureId, true>> = {
    mail: true
};

export default function EncryptionSection({ scope }: { scope: SettingsScope }) {
    if (scope.kind !== 'item') return null;
    return (
        <div className={styles.section}>
            {scope.feature === 'mail' && <MailEncryptionPanel accountId={scope.itemId} />}
        </div>
    );
}

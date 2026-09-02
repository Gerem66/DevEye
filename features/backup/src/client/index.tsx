import type { FeatureClient } from '@deveye/types/sdk/client';

import Backup from './Backup';
import BackupWidget from './BackupWidget';
import DestinationsPanel from './DestinationsPanel';
import JobEncryptionPanel from './JobEncryptionPanel';
import JobGeneralPanel from './JobGeneralPanel';

/**
 * Démonté dès la fermeture : la fiche d'un travail suit une exécution en vol.
 * Pas de `holdSecrecy` : rien n'est chiffré à l'étage gardé.
 */
export const clientEntry: FeatureClient = {
    Widget: BackupWidget,
    Full: Backup,
    settingsPanels: { general: JobGeneralPanel, sources: DestinationsPanel, encryption: JobEncryptionPanel },
    cacheDurationMinutes: 0
};

import type { FeatureClient } from '@deveye/types/sdk/client';

import Backup from './Backup';
import BackupWidget from './BackupWidget';
import DestinationsPanel from './DestinationsPanel';
import JobEncryptionPanel from './JobEncryptionPanel';

/**
 * L'entrée client du module : la carte de comptage, la vue, et les deux
 * panneaux de réglages du manifest (les destinations à l'échelle de la
 * fonctionnalité, la forme des archives à l'échelle d'un travail).
 *
 * Démonté dès la fermeture, comme Déploiement : la fiche d'un travail suit une
 * exécution en vol, et une instance en cache continuerait de la suivre sans
 * être vue. Pas de `holdSecrecy` : rien n'y est chiffré à l'étage gardé, donc
 * rien ne peut déclencher l'invite de mot de passe.
 */
export const clientEntry: FeatureClient = {
    Widget: BackupWidget,
    Full: Backup,
    settingsPanels: { sources: DestinationsPanel, encryption: JobEncryptionPanel },
    cacheDurationMinutes: 0
};

import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { ConfigPanel } from './ConfigPanel';
import { TerminalSettings } from './TerminalSettings';

/**
 * Le panneau Général de la coquille de réglages, aux deux échelles.
 *
 * À l'échelle de la FEATURE : les préférences du terminal distant (le compte
 * des sessions, la fin de session), locales au navigateur. À l'échelle d'un
 * APPAREIL (un id texte : un appareil est un UUID, d'où
 * `SettingsPanelProps<string>`) : sa configuration de collecte. Un seul
 * composant, parce que le manifest déclare un seul onglet `general` par
 * échelle et que l'entrée client le fournit par son id ; le scope tranche.
 */
export default function DevicesSettingsPanel({ scope, canWrite }: SettingsPanelProps<string>) {
    if (scope.kind === 'item') return <ConfigPanel deviceId={scope.itemId} canWrite={canWrite} />;
    return <TerminalSettings canWrite={canWrite} />;
}

import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { ConfigPanel } from './ConfigPanel';
import { TerminalSettings } from './TerminalSettings';

/**
 * Le panneau Général de la coquille de réglages, aux deux échelles : les
 * préférences du terminal (feature) et la configuration de collecte d'un
 * appareil (élément, un UUID, d'où `SettingsPanelProps<string>`). Un seul
 * composant parce que l'entrée client fournit un panneau par id d'onglet.
 */
export default function DevicesSettingsPanel({ scope, canWrite }: SettingsPanelProps<string>) {
    if (scope.kind === 'item') return <ConfigPanel deviceId={scope.itemId} canWrite={canWrite} />;
    return <TerminalSettings canWrite={canWrite} />;
}

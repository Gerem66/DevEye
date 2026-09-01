import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { ConfigPanel } from './ConfigPanel';
import { TerminalSettings } from './TerminalSettings';

/**
 * Les deux onglets de réglages d'un appareil. Ils ne partagent rien : l'un dit
 * ce que son agent collecte, l'autre sous quel compte son terminal s'ouvre. La
 * fonctionnalité elle-même ne règle rien.
 */

/** Ce que l'agent d'un appareil relève, et à quelle cadence. */
export function DevicesCollectPanel({ scope, canWrite }: SettingsPanelProps) {
    if (scope.kind !== 'item') return null;
    return <ConfigPanel deviceId={scope.itemId} canWrite={canWrite} />;
}

/** Comment le terminal distant d'un appareil s'ouvre et se referme. */
export function DevicesTerminalPanel({ scope, canWrite }: SettingsPanelProps) {
    if (scope.kind !== 'item') return null;
    return <TerminalSettings deviceId={scope.itemId} canWrite={canWrite} />;
}

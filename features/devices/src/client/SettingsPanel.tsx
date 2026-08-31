import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { ConfigPanel } from './ConfigPanel';
import { TerminalSettings } from './TerminalSettings';

/**
 * Les deux onglets de réglages de Monitoring. Ils ne partagent rien : la feature
 * règle le terminal, un appareil règle ce que son agent collecte. Un onglet
 * « Général » unique portait les deux et n'annonçait ni l'un ni l'autre.
 */

/** Les préférences du terminal, à l'échelle de la fonctionnalité. */
export function DevicesTerminalPanel({ canWrite }: SettingsPanelProps) {
    return <TerminalSettings canWrite={canWrite} />;
}

/** Ce que l'agent d'un appareil relève, et à quelle cadence. */
export function DevicesCollectPanel({ scope, canWrite }: SettingsPanelProps) {
    if (scope.kind !== 'item') return null;
    return <ConfigPanel deviceId={scope.itemId} canWrite={canWrite} />;
}

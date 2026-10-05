import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import ClientPanel from './ClientPanel';
import DocumentGeneralPanel from './DocumentGeneralPanel';
import IssuerPanel from './IssuerPanel';

/**
 * Un seul onglet « Général », trois échelles : celle de la fonctionnalité porte
 * l'identité de l'émetteur, celle d'un élément porte le client, celle d'un
 * document ses gestes. La coquille monte le même composant pour les trois,
 * c'est donc ici que la bifurcation se fait.
 */
export default function GeneralPanel(props: SettingsPanelProps) {
    if (props.scope.kind === 'item') return <ClientPanel {...props} />;
    if (props.scope.kind === 'record') return <DocumentGeneralPanel {...props} />;
    return <IssuerPanel {...props} />;
}

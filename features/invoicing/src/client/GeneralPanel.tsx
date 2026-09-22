import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import ClientPanel from './ClientPanel';
import IssuerPanel from './IssuerPanel';

/**
 * Un seul onglet « Général », deux échelles : celle de la fonctionnalité porte
 * l'identité de l'émetteur, celle d'un élément porte le client. La coquille
 * monte le même composant pour les deux, c'est donc ici que la bifurcation se
 * fait.
 */
export default function GeneralPanel(props: SettingsPanelProps) {
    return props.scope.kind === 'item' ? <ClientPanel {...props} /> : <IssuerPanel {...props} />;
}

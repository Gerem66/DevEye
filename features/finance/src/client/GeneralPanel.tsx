import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import AccountPanel from './AccountPanel';
import FinanceGeneralPanel from './FinanceGeneralPanel';

/**
 * Un seul onglet « Général », deux échelles : celle de la feature porte la
 * devise et la TVA, celle d'un élément porte le compte. La coquille monte le
 * même composant pour les deux, la bifurcation se fait donc ici.
 */
export default function GeneralPanel(props: SettingsPanelProps) {
    return props.scope.kind === 'item' ? <AccountPanel {...props} /> : <FinanceGeneralPanel {...props} />;
}

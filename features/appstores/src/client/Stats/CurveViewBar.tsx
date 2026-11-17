import { SegmentedControl } from 'deveye-sdk-client';
import type { AppStore } from '../../contracts/domain';

import { ON_STORE, STORE_LABELS } from '../format';
import { setStoresPrefs, useCurveView, type CurveView } from '../prefs';
import { curveViewOf } from './downloads';

const OPTIONS: readonly { value: CurveView; label: string; title: string }[] = [
    { value: 'stores', label: 'Par store', title: 'Une courbe par store' },
    { value: 'total', label: 'Total', title: 'Les stores réunis en une courbe' },
    {
        value: 'previous',
        label: 'Période d’avant',
        title: 'Le total, et en pointillés la période de même durée qui la précède'
    },
    { value: 'average', label: 'Moyenne 7 j', title: 'Le total lissé sur les sept jours précédents' },
    { value: 'apps', label: 'Par app', title: 'Les cinq apps les plus téléchargées, puis les autres' }
];

/**
 * Le choix de ce que montrent les courbes de téléchargements. Un seul choix,
 * retenu dans le navigateur : il vaut pour toutes les courbes de Stores. Sur
 * un seul store, « par store » et « total » tracent la même courbe : un bouton
 * au nom du store les remplace.
 */
export function CurveViewBar({ severalApps, stores }: { severalApps: boolean; stores: readonly AppStore[] }) {
    const view = curveViewOf(useCurveView(severalApps), stores);
    const single = stores.length === 1 ? stores[0] : null;
    const options = OPTIONS.filter(
        (option) => (severalApps || option.value !== 'apps') && (single === null || option.value !== 'total')
    ).map((option) =>
        single !== null && option.value === 'stores'
            ? { ...option, label: STORE_LABELS[single], title: `Les téléchargements ${ON_STORE[single]}` }
            : option
    );
    return (
        <SegmentedControl
            value={view}
            options={options}
            onChange={(next) => setStoresPrefs({ curveView: next })}
            aria-label='Courbes affichées'
        />
    );
}

export default CurveViewBar;

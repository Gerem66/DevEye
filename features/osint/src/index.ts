/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats d'OSINT vivent dans deveye-types (API publiée d'une native) ;
 * le module les ré-exporte pour être complet au format template, sans les
 * dupliquer.
 */
export { manifest } from './manifest';
export {
    osintCommands,
    osintHistory,
    osintHistoryClear,
    osintHistoryRemove,
    osintKeyList,
    osintLookup,
    osintProbe,
    osintSetKey
} from 'deveye-types';

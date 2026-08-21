/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats de Météo vivent dans deveye-types (API publiée d'une native) ;
 * le module les ré-exporte pour être complet au format template, sans les
 * dupliquer.
 */
export { manifest } from './manifest';
export {
    weatherAdd,
    weatherCommands,
    weatherGet,
    weatherKeyList,
    weatherList,
    weatherRemove,
    weatherReorder,
    weatherSetKey,
    weatherSetPrimary,
    weatherUpdate
} from 'deveye-types';

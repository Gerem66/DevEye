/**
 * L'entrée isomorphe du module : le manifest et les contrats.
 *
 * Les contrats vivent dans le module, pas dans @deveye/types : rien d'autre
 * dans l'app ne lit les blocs, dossiers ou résumés des notes.
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

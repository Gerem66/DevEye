/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats de Git vivent ICI (src/contracts), comme chez un module
 * externe : @deveye/types ne garde que l'identité de la feature (id,
 * descripteur) et les couplages déclarés (les providers que Projets consomme,
 * et celui qu'il offre au module pour la version d'un projet).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

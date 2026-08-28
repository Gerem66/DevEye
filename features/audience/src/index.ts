/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats d'Audience vivent ICI (src/contracts), comme chez un module
 * externe : @deveye/types ne garde que l'identité de la feature (id,
 * descripteur) et les couplages déclarés (les providers que Projets consomme).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

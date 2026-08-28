/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats de Mail vivent ICI (src/contracts), comme chez un module
 * externe : @deveye/types ne garde que l'identité de la feature (id,
 * descripteur) et les couplages déclarés (le transport des alertes e-mail
 * que le module offre à l'app, et son dialogue de compte).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

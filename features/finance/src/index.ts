/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats des Finances vivent ICI, dans le module (src/contracts), comme
 * chez un module externe : @deveye/types ne garde que l'identité de la feature
 * (id, descripteur). Le grand livre est une feature isolée : rien d'autre dans
 * l'app ne lit ses types, donc son vocabulaire n'a rien à faire dans le
 * package publié.
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

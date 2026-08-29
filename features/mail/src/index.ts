/**
 * L'entrée isomorphe du module : le manifest, et les contrats. Ils vivent ici,
 * @deveye/types ne gardant que l'identité de la feature et les couplages
 * déclarés (le transport des alertes e-mail, le dialogue de compte).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

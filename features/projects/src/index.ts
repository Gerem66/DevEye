/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Ces contrats vivent ici : @deveye/types ne garde que l'identité de la feature,
 * le vocabulaire des statuts que les autres features parlent, et le couplage
 * déclaré (`PROJECTS_USAGE_PROVIDER`).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

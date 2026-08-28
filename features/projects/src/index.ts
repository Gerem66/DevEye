/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats de Projets vivent ICI (src/contracts), comme chez un module
 * externe : @deveye/types ne garde que l'identité de la feature (id,
 * descripteur), le vocabulaire des statuts que les autres features parlent,
 * et le couplage déclaré (`PROJECTS_USAGE_PROVIDER`, ce que Projets offre aux
 * modules qui rattachent leurs éléments à un projet).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

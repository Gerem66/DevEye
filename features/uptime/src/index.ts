/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats d'Uptime vivent ICI (src/contracts), comme chez un module
 * externe : @deveye/types ne garde que l'identité de la feature (id,
 * descripteur, sujet live, émetteur de notifications) et les deux contrats de
 * couplage que Projets consomme (`UPTIME_ITEMS_PROVIDER`,
 * `UPTIME_CLIENT_PROVIDER`).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

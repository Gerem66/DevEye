/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats d'OSINT vivent ICI, dans le module (src/contracts), comme chez
 * un module externe : @deveye/types ne garde que l'identité de la feature (id,
 * descripteur). Une feature isolée n'étale pas son vocabulaire dans le
 * package publié.
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

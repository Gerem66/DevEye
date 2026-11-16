/**
 * L'entrée isomorphe du module : le manifest et les contrats. @deveye/types ne
 * garde que l'identité de la feature et les providers échangés avec Projets.
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

/**
 * Les contrats vivent dans le module : rien d'autre dans l'app ne lit ses
 * types, @deveye/types ne garde que l'identité de la feature.
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

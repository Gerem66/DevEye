/**
 * Les contrats vivent dans le module ; @deveye/types ne garde que l'identité
 * de la feature, le contrat `SENTINEL_AGENT_CONFIG_PROVIDER` et le protocole
 * agent (infrastructure, pas feature).
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

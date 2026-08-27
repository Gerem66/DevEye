/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats de Sentinelle vivent ICI (src/contracts), comme chez un module
 * externe : @deveye/types ne garde que l'identité de la feature (id,
 * descripteur, sujet live, émetteur de notifications) et le contrat de
 * couplage que l'app consomme pour composer la config d'un agent
 * (`SENTINEL_AGENT_CONFIG_PROVIDER`, avec `DEFAULT_SENTINEL_INTEGRITY_MINUTES`
 * à côté de lui). Le protocole agent (rapport, instants, manifeste de
 * persistance, fenêtre d'authentification) reste au package : c'est
 * l'infrastructure, pas la feature.
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

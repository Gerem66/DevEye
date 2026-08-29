/**
 * L'entrée isomorphe du module : le manifest, et les contrats. Pas de domaine
 * à lui : @deveye/types garde public tout ce que l'infrastructure et les autres
 * modules parlent (appareils, rapport, métriques, présence, protocole agent,
 * enrôlement, commandes de transport `agent.*`).
 */
export { manifest } from './manifest';
export * from './contracts/commands';

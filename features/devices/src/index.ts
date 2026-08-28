/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats de la flotte et des métriques vivent ICI (src/contracts) ; le
 * module n'a pas de domaine à lui : @deveye/types garde public tout ce que
 * l'infrastructure et les autres modules parlent (le vocabulaire des
 * appareils, `Device`, `DeviceRow`, le rapport, les métriques, la présence
 * que l'ingestion écrit, le protocole agent, l'enrôlement et les codes de
 * liaison, et les commandes de transport `agent.*`).
 */
export { manifest } from './manifest';
export * from './contracts/commands';

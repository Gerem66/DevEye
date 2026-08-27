/**
 * L'entrée isomorphe du module : le manifest, et les contrats.
 *
 * Les contrats des Notes vivent ICI, dans le module (src/contracts), comme
 * chez un module externe : @deveye/types ne garde que l'identité de la feature
 * (id, descripteur). Les notes sont une feature isolée : rien d'autre dans
 * l'app ne lit ses blocs, ses dossiers ni ses résumés, donc son vocabulaire
 * n'a rien à faire dans le package publié.
 */
export { manifest } from './manifest';
export * from './contracts/domain';
export * from './contracts/commands';

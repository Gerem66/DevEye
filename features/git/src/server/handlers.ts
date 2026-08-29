import { gitCredentialFeatures } from './credentials';
import { gitCrudFeatures } from './crud';
import { gitReadFeatures } from './read';

/**
 * La feature Git : les dépôts de l'espace, leurs jetons et leur cache. Elle est
 * de premier rang, pas un onglet de Projets : un projet ne fait que pointer un
 * dépôt (`projects.repoLink`), et ce pointeur est tout ce que Projets en connaît.
 */
export const gitHandlers = [...gitCredentialFeatures, ...gitCrudFeatures, ...gitReadFeatures];

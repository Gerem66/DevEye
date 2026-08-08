import { gitCredentialFeatures } from './credentials';
import { gitRepoFeatures } from './repo';
import { gitReadFeatures } from './read';

/**
 * La feature Git : les dépôts de l'espace, leurs jetons et leur cache.
 *
 * Elle est de premier rang, comme Notes ou Uptime — et non un onglet des
 * Projets. Un projet ne fait que **pointer** un de ces dépôts
 * (`project.repoLink`), et ce pointeur est tout ce que le module Projets en
 * connaît.
 */
export const gitFeatures = [...gitCredentialFeatures, ...gitRepoFeatures, ...gitReadFeatures];

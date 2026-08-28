import { gitCredentialFeatures } from './credentials';
import { gitCrudFeatures } from './crud';
import { gitReadFeatures } from './read';

/**
 * La feature Git : les dépôts de l'espace, leurs jetons et leur cache.
 *
 * Elle est de premier rang, comme Notes ou Uptime — et non un onglet des
 * Projets. Un projet ne fait que **pointer** un de ces dépôts
 * (`project.repoLink`, dans l'app), et ce pointeur est tout ce que le module
 * Projets en connaît.
 *
 * Trois fichiers, trois natures :
 *
 *  - `credentials.ts` : les jetons GitHub de l'espace, quatre gestes sur la
 *    table du module.
 *  - `crud.ts` : les dépôts, leur ordre, et les gestes qui réveillent ou
 *    interrogent le service de fond (`GitSync`, `service.ts`).
 *  - `read.ts` : la lecture du cache que le service alimente ; une seule
 *    commande y sort vers GitHub, le diff d'un commit.
 */
export const gitHandlers = [...gitCredentialFeatures, ...gitCrudFeatures, ...gitReadFeatures];

import { agentCommands } from '@deveye/types';
import { commandsApi, featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/**
 * Les deux voies typées du module.
 *
 * `api` envoie les commandes de la feature (`devices.*` : la flotte, les
 * métriques stockées, les codes de liaison), retrouvées dans le manifest.
 * `agent` envoie les commandes de TRANSPORT (`agent.*` : fichiers, terminal,
 * journaux, paquets, alimentation, cycle de vie, mise à jour, abonnement aux
 * métriques), qui restent natives : elles relaient un ordre au hub des agents
 * et sont accessibles à tout client sous le droit `devices`. Leurs réponses
 * différées arrivent par `onServerEvent`.
 */
export const api = featureApi(manifest);
export const agent = commandsApi(agentCommands);

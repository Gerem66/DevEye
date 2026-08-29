import { agentCommands } from '@deveye/types';
import { commandsApi, featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/**
 * `api` envoie les commandes de la feature (`devices.*`). `agent` envoie les
 * commandes de transport (`agent.*`), natives : elles relaient un ordre au hub
 * des agents, et leurs réponses différées arrivent par `onServerEvent`.
 */
export const api = featureApi(manifest);
export const agent = commandsApi(agentCommands);

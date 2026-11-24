import { featureApi, withSecrecy } from 'deveye-sdk-client';

import { manifest } from '../manifest';

const commands = featureApi(manifest);

/**
 * Les commandes du module. Une base protégée garde ses secrets sous le mot de
 * passe du compte : la commande qui les demande session verrouillée répond
 * `locked`, et l'invite du mot de passe prend alors le relais avant de la
 * rejouer. Une base ouverte ne répond jamais ainsi.
 */
export const api: typeof commands = {
    ...commands,
    send: ((name, input, opts) =>
        commands.send(name, input, opts).catch((e: unknown) => {
            if ((e as { code?: unknown } | null)?.code !== 'locked') throw e;
            return withSecrecy(() => commands.send(name, input, opts));
        })) as typeof commands.send
};

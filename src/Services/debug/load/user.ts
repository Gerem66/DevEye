import { setTimeout as delay } from 'node:timers/promises';
import { FeatureError } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import { openTestAccount, signIn } from '../e2e/accounts';
import { createTestClient, type TestClient } from '../e2e/client';
import type { TestIdentity } from '../e2e/identity';
import { noteCycle, type LoadActions, type Send } from './actions';
import type { Meter } from './meter';

/** Entre deux actions : 5 s en moyenne, bien plus actif qu'une vraie personne. */
const THINK_MIN_MS = 2000;
const THINK_MAX_MS = 8000;
/** La part des actions qui écrivent une note. */
const WRITE_SHARE = 0.2;

export interface UserEnv {
    db: Database;
    base: string;
    host: string;
    runToken: string;
    /** Le hachage du mot de passe commun aux comptes de l'essai. */
    passwordHash: string;
    actions: LoadActions;
    meter: Meter;
    /** Coupé à la fin de la montée, ou sur Arrêter : chaque utilisateur s'en va. */
    signal: AbortSignal;
}

function timedSend(client: TestClient, { meter, signal }: UserEnv): Send {
    return async <T>(command: string, input: unknown): Promise<T> => {
        const started = performance.now();
        try {
            const out = await client.send<T>(command, input);
            meter.command(performance.now() - started, 'ok');
            return out;
        } catch (e) {
            // Une socket fermée par le départ de l'utilisateur n'est pas une erreur du serveur.
            if (!signal.aborted) {
                const refused = e instanceof FeatureError && e.code !== 'internal';
                meter.command(performance.now() - started, refused ? 'refused' : 'error');
            }
            throw e;
        }
    };
}

async function act(send: Send, actions: LoadActions): Promise<void> {
    if (actions.writes && Math.random() < WRITE_SHARE) return noteCycle(send);
    const pool = actions.views.length > 0 ? actions.views : actions.home;
    await send(pool[Math.floor(Math.random() * pool.length)], {});
}

/**
 * Un utilisateur simulé, de son arrivée à son départ : un compte jetable, la
 * vraie connexion, la session et l'accueil comme une page qui s'ouvre, puis une
 * action toutes les quelques secondes jusqu'à la fin de la montée. Son compte
 * et ce qu'il a écrit partent au ménage de l'essai.
 */
export async function simulateUser(identity: TestIdentity, env: UserEnv): Promise<void> {
    const client = createTestClient({ base: env.base, host: env.host, runToken: env.runToken, signal: env.signal });
    const send = timedSend(client, env);
    try {
        try {
            await openTestAccount(env.db, identity, env.passwordHash);
            const started = performance.now();
            await signIn(client, identity);
            const me = await client.http('/api/auth/me');
            if (me.status !== 200) throw new Error(`/api/auth/me : HTTP ${me.status}`);
            // Les tuiles se chargent ensemble ; une tuile refusée n'empêche pas d'arriver.
            await Promise.allSettled(env.actions.home.map((command) => send(command, {})));
            env.meter.arrived(performance.now() - started);
        } catch {
            if (!env.signal.aborted) env.meter.arrivalFailed();
            return;
        }
        try {
            while (!env.signal.aborted && client.connected()) {
                await delay(THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS), undefined, {
                    signal: env.signal
                });
                await act(send, env.actions).catch(() => undefined);
            }
        } catch {
            // La pause interrompue : la montée est finie.
        } finally {
            env.meter.left(!env.signal.aborted);
        }
    } finally {
        client.close();
    }
}

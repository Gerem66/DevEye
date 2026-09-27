import { randomBytes } from 'node:crypto';
import type { DebugBenchProfile } from '@deveye/types';

import { hashPassword } from '@/auth/argon';
import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { Mailer } from '@/Services/mailer';
import { env } from '@/Utils/Env';
import { loopWatch } from './system';

export interface ProbeContext {
    db: Database;
    crypt: Encryption;
    mailer: Mailer;
    origin: string;
    /** L'administrateur qui mesure : ses propres lignes servent aux lectures. */
    userId: number;
    signal: AbortSignal;
}

export interface Probe {
    id: string;
    label: string;
    description: string;
    iterations: Record<DebugBenchProfile, number>;
    /** Au-delà, la sonde s'arrête avec ce qu'elle a : une mesure ne doit jamais peser sur la production. */
    capMs: number;
    skip?(ctx: ProbeContext): string | null;
    /** Une itération ; rend sa propre durée quand elle ne se mesure pas de l'extérieur. */
    once(ctx: ProbeContext): Promise<number | void>;
}

/** Ce que mesure le navigateur, puis transmet avec la demande. */
export const CLIENT_PROBES = [
    {
        id: 'ws.command',
        label: 'Commande par la socket',
        description: 'L’aller-retour d’une commande vide, mesuré dans votre navigateur.',
        clientSide: true
    },
    {
        id: 'http.browser',
        label: 'Requête HTTP du navigateur',
        description: 'Le temps d’un appel à /api/health depuis votre navigateur.',
        clientSide: true
    }
] as const;

class Rollback extends Error {}

const PAYLOAD = randomBytes(1024);

async function timedFetch(url: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export const PROBES: readonly Probe[] = [
    {
        id: 'loop.idle',
        label: 'Boucle d’événements',
        description: 'Le retard de la boucle pendant une seconde sans rien lui demander : la charge de fond.',
        iterations: { quick: 1, full: 1 },
        capMs: 2000,
        once: async ({ signal }) => {
            const watch = loopWatch();
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 1000);
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    resolve(null);
                });
            });
            return watch.stop().p99;
        }
    },
    {
        id: 'db.ping',
        label: 'Aller-retour avec la base',
        description: 'Un SELECT 1 : le réseau et la file du pool de connexions.',
        iterations: { quick: 10, full: 30 },
        capMs: 3000,
        once: async ({ db }) => {
            await db.queryable.query('SELECT 1');
        }
    },
    {
        id: 'db.read',
        label: 'Lectures représentatives',
        description: 'Un compte, ses espaces, puis la liste de tous les comptes.',
        iterations: { quick: 5, full: 20 },
        capMs: 3000,
        once: async ({ db, userId }) => {
            await db.users.findById(userId);
            await db.workspaces.findAccessibleByUser(userId);
            await db.users.listForAdmin();
        }
    },
    {
        id: 'db.write',
        label: 'Écriture annulée',
        description: 'Une écriture en transaction, aussitôt annulée : rien ne reste en base.',
        iterations: { quick: 3, full: 10 },
        capMs: 3000,
        once: async ({ db, origin, userId }) => {
            try {
                await db.transaction(async (tx) => {
                    await tx.instanceSettings.put('bench.scratch', origin, String(Date.now()), userId);
                    throw new Rollback();
                });
            } catch (e) {
                if (!(e instanceof Rollback)) throw e;
            }
        }
    },
    {
        id: 'crypto.seal',
        label: 'Scellement',
        description: 'Sceller puis rouvrir 1 Kio sous la clé du serveur.',
        iterations: { quick: 50, full: 200 },
        capMs: 2000,
        once: async ({ crypt }) => {
            const sealed = crypt.sealFor('module:debug', PAYLOAD, 'bench');
            if (!crypt.openFor('module:debug', sealed, 'bench')) throw new Error('Scellé illisible');
        }
    },
    {
        id: 'crypto.argon2',
        label: 'Hachage d’un mot de passe',
        description: 'Le coût d’une connexion. Il occupe le pool de threads : peu d’itérations.',
        iterations: { quick: 1, full: 3 },
        capMs: 5000,
        once: async () => {
            await hashPassword(randomBytes(12).toString('base64url'));
        }
    },
    {
        id: 'http.loopback',
        label: 'HTTP en local',
        description: 'Une requête du serveur à lui-même : la pile HTTP, sans réseau.',
        iterations: { quick: 10, full: 30 },
        capMs: 3000,
        once: async ({ signal }) => timedFetch(`http://127.0.0.1:${env.LISTEN_PORT}/api/health`, signal)
    },
    {
        id: 'http.public',
        label: 'HTTP par l’adresse publique',
        description: 'La même requête par l’adresse publique : DNS, TLS et proxy compris.',
        iterations: { quick: 3, full: 10 },
        capMs: 5000,
        once: async ({ origin, signal }) => timedFetch(`${origin}/api/health`, signal)
    },
    {
        id: 'smtp.verify',
        label: 'Poignée de main SMTP',
        description: 'La connexion au serveur d’envoi, sans rien envoyer.',
        iterations: { quick: 1, full: 1 },
        capMs: 10_000,
        skip: ({ mailer }) => (mailer.configured ? null : 'Aucun serveur SMTP configuré'),
        once: async ({ mailer }) => {
            await mailer.verify();
        }
    }
];

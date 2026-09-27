import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** L'en-tête que portent les requêtes d'un essai en cours. */
export const RUN_HEADER = 'x-deveye-run';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

let token: Buffer | null = null;

interface GatedRequest {
    headers: IncomingHttpHeaders;
    socket: { remoteAddress?: string };
}

/**
 * La porte des essais : un jeton tiré à chaque essai, gardé en mémoire le temps
 * qu'il dure, et honoré seulement depuis ce serveur même (l'adresse TCP réelle,
 * qu'aucun en-tête transmis ne change). Elle lève les plafonds de débit, qu'un
 * essai relancé plusieurs fois atteindrait, et écarte ce trafic du suivi d'usage.
 */
export const runGate = {
    open(): string {
        const value = randomBytes(32).toString('base64url');
        token = Buffer.from(value);
        return value;
    },
    close(): void {
        token = null;
    },
    allows(req: GatedRequest): boolean {
        if (!token || !LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
        const header = req.headers[RUN_HEADER];
        if (typeof header !== 'string') return false;
        const given = Buffer.from(header);
        return given.length === token.length && timingSafeEqual(given, token);
    }
};

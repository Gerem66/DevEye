import type { Socket } from 'node:net';
import tls from 'node:tls';

import { TLS_MIN_VERSION, type TlsStore } from '../engine/tls';
import { ImapSession, type ImapContext } from './session';

/** L'écouteur IMAP : TLS implicite seulement, aucune session ne commence en clair. */

const MAX_CONNECTIONS = 500;
const MAX_PER_IP = 20;

export interface ImapServer {
    listen(port: number): Promise<number>;
    /** Congédie les sessions et ferme le port, sans attendre qu'un client réponde. */
    stop(): Promise<void>;
    sessions(): number;
}

export function createImapServer(ctx: ImapContext, certificates: TlsStore): ImapServer {
    const open = new Map<Socket, ImapSession>();
    const perIp = new Map<string, number>();
    const pem = certificates.current();
    if (!pem) throw new Error('IMAP : aucun certificat, le port reste fermé');

    const server = tls.createServer({ ...pem, minVersion: TLS_MIN_VERSION }, (socket) => {
        const ip = socket.remoteAddress ?? '';
        const held = perIp.get(ip) ?? 0;
        if (open.size >= MAX_CONNECTIONS || held >= MAX_PER_IP) {
            socket.end('* BYE Too many connections\r\n');
            return;
        }
        perIp.set(ip, held + 1);
        open.set(socket, new ImapSession(socket, ctx, ip));
        socket.on('close', () => {
            open.delete(socket);
            const left = (perIp.get(ip) ?? 1) - 1;
            if (left <= 0) perIp.delete(ip);
            else perIp.set(ip, left);
        });
    });
    const unsubscribe = certificates.subscribe((next) =>
        server.setSecureContext({ ...next, minVersion: TLS_MIN_VERSION })
    );
    // Une poignée de main ratée (balayage de ports, client en clair) n'est pas une panne du serveur.
    server.on('tlsClientError', () => undefined);

    return {
        listen: (port) =>
            new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, () => {
                    server.off('error', reject);
                    const address = server.address();
                    resolve(typeof address === 'object' && address ? address.port : port);
                });
            }),
        stop: () =>
            new Promise((resolve) => {
                unsubscribe();
                for (const session of open.values()) session.destroy();
                server.close(() => resolve());
            }),
        sessions: () => open.size
    };
}

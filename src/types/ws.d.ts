/**
 * Types minimaux pour `ws`, dépendance transitive de `@fastify/websocket`
 * qu'on utilise ici en client sortant (voir `Services/integrations/dokploy.ts`).
 *
 * Pas de `@types/ws` posé pour si peu : ce fichier ne déclare que ce dont on se
 * sert réellement, pas toute la surface du paquet.
 *
 * Le volet **serveur** n'est là que pour les tests : `dokployLog.test.ts` monte
 * une vraie WebSocket pour reproduire le seul comportement qui compte — Dokploy
 * ne referme jamais la connexion. Un faux client mentirait précisément sur ce
 * point, donc le serveur d'essai est réel, et ses types avec.
 */
declare module 'ws' {
    export default class WebSocket {
        constructor(address: string, options?: { headers?: Record<string, string> });
        on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): this;
        on(event: 'close', listener: () => void): this;
        on(event: 'error', listener: (err: Error) => void): this;
        terminate(): void;
    }

    /** Le pair vu depuis le serveur : de quoi émettre puis, éventuellement, fermer. */
    export interface ServerSocket {
        send(data: string): void;
        close(): void;
    }

    export class WebSocketServer {
        constructor(options: { server: import('node:http').Server });
        on(event: 'connection', listener: (socket: ServerSocket) => void): this;
        close(): void;
    }
}

/**
 * Types minimaux pour `ws`, dépendance transitive de `@fastify/websocket`
 * qu'on utilise en client sortant dans l'adaptateur Dokploy du module
 * Déploiement (`features/deploy/src/server/dokploy.ts`, qui déclare `ws` en
 * dépendance ; le projet serveur des modules inclut cette déclaration).
 *
 * Pas de `@types/ws` posé pour si peu : ce fichier ne déclare que ce dont on se
 * sert réellement, pas toute la surface du paquet.
 *
 * Le volet **serveur** n'est là que pour les tests : le `dokploy.test.ts` du
 * module monte une vraie WebSocket pour reproduire le seul comportement qui
 * compte — Dokploy ne referme jamais la connexion. Un faux client mentirait
 * précisément sur ce point, donc le serveur d'essai est réel, et ses types avec.
 */
declare module 'ws' {
    /**
     * Les options de connexion que l'adaptateur pose : les en-têtes, et l'une
     * des deux prises sur la couche transport (la résolution DNS du garde, ou
     * la socket elle-même vers un relais local).
     */
    export interface ClientOptions {
        headers?: Record<string, string>;
        lookup?: typeof import('node:dns').lookup;
        createConnection?: (options: {
            host: string;
            port: number;
            path?: string;
            servername?: string;
        }) => import('node:stream').Duplex;
    }

    export default class WebSocket {
        constructor(address: string, options?: ClientOptions);
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

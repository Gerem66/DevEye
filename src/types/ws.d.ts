/**
 * Types minimaux pour `ws`, dépendance transitive de `@fastify/websocket`
 * qu'on utilise ici en client sortant (voir `Services/integrations/dokploy.ts`).
 *
 * Pas de `@types/ws` posé pour si peu : ce fichier ne déclare que ce dont
 * l'adaptateur se sert réellement, pas toute la surface du paquet.
 */
declare module 'ws' {
    export default class WebSocket {
        constructor(address: string, options?: { headers?: Record<string, string> });
        on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): this;
        on(event: 'close', listener: () => void): this;
        on(event: 'error', listener: (err: Error) => void): this;
        terminate(): void;
    }
}

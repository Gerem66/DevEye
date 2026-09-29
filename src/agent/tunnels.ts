import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';

import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_TUNNEL_CLOSE,
    AGENT_TUNNEL_CREDIT,
    AGENT_TUNNEL_OPEN,
    AGENT_TUNNEL_PIECE_BYTES,
    AGENT_TUNNEL_WRITE,
    type AgentTunnelClosedPayload,
    type AgentTunnelDataPayload,
    type AgentTunnelOpenedPayload
} from '@deveye/types';

import { agentFrame } from './orders';

/** Pièces que l'agent peut envoyer d'avance : 512 Kio en vol au plus par tunnel. */
const TUNNEL_WINDOW = 8;
/** Les crédits repartent par paquets : une trame de crédit par pièce doublerait le trafic. */
const CREDIT_BATCH = 4;
/** L'agent abandonne la cible au bout de 10 s ; au-delà, il ne connaît pas l'ordre. */
const OPEN_TIMEOUT_MS = 15_000;
/** Au-delà, une écriture attend que la socket de l'agent se vide. */
const HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 20;

interface TunnelFlow {
    deviceId: string;
    tunnelId: string;
    socket: WebSocket;
    stream: Duplex;
    /** Tant que `tunnel.opened` n'est pas arrivé. */
    opening: { resolve: () => void; reject: (e: Error) => void } | null;
    /** Pièces que l'agent peut encore envoyer. */
    credits: number;
    /** Pièces reçues dont le crédit n'a pas encore été rendu. */
    owed: number;
    /** Plus rien ne part vers l'agent : il a fermé, ou sa session est tombée. */
    ended: boolean;
}

const flowKey = (deviceId: string, tunnelId: string): string => `${deviceId}\n${tunnelId}`;

/**
 * Les connexions TCP qu'un agent ouvre de son côté et relaie : une base que
 * seule la machine joint devient un flux ici. L'agent n'envoie que ce que le
 * consommateur a pris (crédits), si bien qu'un `pg_dump` lent freine la
 * machine au lieu de remplir la mémoire du serveur.
 */
export class AgentTunnels {
    private readonly flows = new Map<string, TunnelFlow>();

    constructor(private readonly socketOf: (deviceId: string) => WebSocket | undefined) {}

    async open(deviceId: string, target: { host: string; port: number }): Promise<Duplex> {
        const socket = this.socketOf(deviceId);
        if (!socket) throw new Error('La machine n’est pas connectée.');
        const flow: TunnelFlow = {
            deviceId,
            tunnelId: randomUUID(),
            socket,
            stream: null as unknown as Duplex,
            opening: null,
            credits: TUNNEL_WINDOW,
            owed: 0,
            ended: false
        };
        flow.stream = this.streamOf(flow);
        const opened = new Promise<void>((resolve, reject) => {
            flow.opening = { resolve, reject };
        });
        // Inscrit avant l'ordre : une réponse immédiate ne doit pas se perdre.
        this.flows.set(flowKey(deviceId, flow.tunnelId), flow);
        const timer = setTimeout(
            () =>
                this.end(
                    flow,
                    'La machine ne répond pas à l’ouverture du tunnel : son agent est peut-être à mettre à jour.'
                ),
            OPEN_TIMEOUT_MS
        );
        timer.unref();
        this.send(flow, AGENT_TUNNEL_OPEN, {
            tunnelId: flow.tunnelId,
            host: target.host,
            port: target.port,
            window: TUNNEL_WINDOW
        });
        try {
            await opened;
        } finally {
            clearTimeout(timer);
        }
        return flow.stream;
    }

    opened(deviceId: string, socket: WebSocket, payload: AgentTunnelOpenedPayload): void {
        const flow = this.flowOf(deviceId, socket, payload.tunnelId);
        if (!flow?.opening) return;
        flow.opening.resolve();
        flow.opening = null;
    }

    /** Une pièce au-delà des crédits accordés ferme le tunnel : un agent qui déborde ne remplit pas la mémoire. */
    data(deviceId: string, socket: WebSocket, payload: AgentTunnelDataPayload): void {
        const flow = this.flowOf(deviceId, socket, payload.tunnelId);
        if (!flow || flow.opening) return;
        if (flow.credits <= 0) {
            this.end(flow, 'L’agent a envoyé plus que ce qui lui était permis.');
            return;
        }
        flow.credits -= 1;
        flow.owed += 1;
        flow.stream.push(Buffer.from(payload.data, 'base64'));
    }

    closed(deviceId: string, socket: WebSocket, payload: AgentTunnelClosedPayload): void {
        const flow = this.flowOf(deviceId, socket, payload.tunnelId);
        if (!flow) return;
        flow.ended = true;
        if (payload.error || flow.opening) {
            this.end(flow, payload.error ?? 'La machine a fermé le tunnel.');
            return;
        }
        this.flows.delete(flowKey(flow.deviceId, flow.tunnelId));
        flow.stream.push(null);
    }

    /** La session de l'agent est tombée : chacun de ses tunnels échoue. */
    failSocket(socket: WebSocket, reason: string): void {
        for (const flow of [...this.flows.values()]) {
            if (flow.socket !== socket) continue;
            flow.ended = true;
            this.end(flow, reason);
        }
    }

    private flowOf(deviceId: string, socket: WebSocket, tunnelId: string): TunnelFlow | null {
        const flow = this.flows.get(flowKey(deviceId, tunnelId));
        return flow && flow.socket === socket ? flow : null;
    }

    /**
     * Oublie le tunnel et le ferme sur la machine si elle l'ignore encore.
     * Avant `tunnel.opened`, personne n'écoute le flux : l'erreur va à la
     * promesse d'ouverture, jamais à un événement `error` sans écouteur.
     */
    private end(flow: TunnelFlow, error: string | null): void {
        if (!this.flows.delete(flowKey(flow.deviceId, flow.tunnelId))) return;
        if (!flow.ended) {
            flow.ended = true;
            this.send(flow, AGENT_TUNNEL_CLOSE, { tunnelId: flow.tunnelId });
        }
        if (flow.opening) {
            flow.opening.reject(new Error(error ?? 'Tunnel fermé avant son ouverture.'));
            flow.opening = null;
            flow.stream.destroy();
            return;
        }
        if (error && !flow.stream.destroyed) flow.stream.destroy(new Error(error));
    }

    private streamOf(flow: TunnelFlow): Duplex {
        return new Duplex({
            read: () => {
                if (flow.owed < CREDIT_BATCH) return;
                this.send(flow, AGENT_TUNNEL_CREDIT, { tunnelId: flow.tunnelId, credits: flow.owed });
                flow.credits += flow.owed;
                flow.owed = 0;
            },
            write: (chunk: Buffer, _encoding, callback) => {
                this.write(flow, chunk).then(() => callback(), callback);
            },
            final: (callback) => {
                this.end(flow, null);
                callback();
            },
            destroy: (error, callback) => {
                this.end(flow, null);
                callback(error);
            }
        });
    }

    private async write(flow: TunnelFlow, chunk: Buffer): Promise<void> {
        for (let offset = 0; offset < chunk.length; offset += AGENT_TUNNEL_PIECE_BYTES) {
            while (!flow.ended && flow.socket.bufferedAmount > HIGH_WATER_BYTES) {
                await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
            }
            if (flow.ended) throw new Error('Le tunnel est fermé.');
            const piece = chunk.subarray(offset, offset + AGENT_TUNNEL_PIECE_BYTES);
            this.send(flow, AGENT_TUNNEL_WRITE, { tunnelId: flow.tunnelId, data: piece.toString('base64') });
        }
    }

    /** Une trame vers la session du tunnel ; une session remplacée ne reçoit plus rien. */
    private send(flow: TunnelFlow, command: string, payload: unknown): void {
        if (this.socketOf(flow.deviceId) !== flow.socket) return;
        try {
            flow.socket.send(agentFrame(command, payload));
        } catch {
            /* la session se ferme : `failSocket` solde le tunnel */
        }
    }
}

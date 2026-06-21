import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_COLLECT,
    AGENT_CONFIG,
    DEVICE_PRESENCE_EVENT,
    DEVICE_REPORT_EVENT,
    METRICS_PUSH_EVENT,
    type AgentConfigPayload,
    type DevicePresence,
    type DeviceReport,
    type MetricSnapshot
} from 'deveye-types';

/**
 * In-memory hub coordinating live monitoring between agent sockets (producers)
 * and authenticated user sockets (subscribers). Metrics are also persisted by
 * the agent WS handler; this hub only fans out the real-time stream.
 *
 * State is process-local. For multi-instance deployments this would move to a
 * shared pub/sub, but the interface here is intentionally narrow so that swap
 * stays isolated.
 */
export class MonitorHub {
    /** deviceId -> connected agent socket. */
    private readonly agents = new Map<string, WebSocket>();
    /** deviceId -> set of subscriber (user) sockets. */
    private readonly subscribers = new Map<string, Set<WebSocket>>();
    /** subscriber socket -> set of deviceIds it watches (for cleanup). */
    private readonly socketDevices = new Map<WebSocket, Set<string>>();

    agentOnline(deviceId: string, socket: WebSocket): void {
        this.agents.set(deviceId, socket);
        this.publishPresence(deviceId, true);
    }

    agentOffline(deviceId: string): void {
        this.agents.delete(deviceId);
        this.publishPresence(deviceId, false);
    }

    isOnline(deviceId: string): boolean {
        return this.agents.has(deviceId);
    }

    /** Ask a connected agent to push a fresh sample + report now. */
    requestCollect(deviceId: string): boolean {
        const socket = this.agents.get(deviceId);
        if (!socket) return false;
        socket.send(JSON.stringify({ command: AGENT_COLLECT, payload: {} }));
        return true;
    }

    /** Push updated collection config to a connected agent. No-op if offline. */
    pushConfig(deviceId: string, config: AgentConfigPayload): boolean {
        const socket = this.agents.get(deviceId);
        if (!socket) return false;
        socket.send(JSON.stringify({ command: AGENT_CONFIG, payload: config }));
        return true;
    }

    onlineDevices(deviceIds: string[]): Record<string, boolean> {
        const out: Record<string, boolean> = {};
        for (const id of deviceIds) out[id] = this.agents.has(id);
        return out;
    }

    subscribe(socket: WebSocket, deviceIds: string[]): void {
        let watched = this.socketDevices.get(socket);
        if (!watched) {
            watched = new Set();
            this.socketDevices.set(socket, watched);
        }
        for (const id of deviceIds) {
            watched.add(id);
            let set = this.subscribers.get(id);
            if (!set) {
                set = new Set();
                this.subscribers.set(id, set);
            }
            set.add(socket);
        }
    }

    unsubscribe(socket: WebSocket, deviceIds: string[]): void {
        const watched = this.socketDevices.get(socket);
        for (const id of deviceIds) {
            watched?.delete(id);
            const set = this.subscribers.get(id);
            set?.delete(socket);
            if (set && set.size === 0) this.subscribers.delete(id);
        }
    }

    dropSubscriber(socket: WebSocket): void {
        const watched = this.socketDevices.get(socket);
        if (!watched) return;
        for (const id of watched) {
            const set = this.subscribers.get(id);
            set?.delete(socket);
            if (set && set.size === 0) this.subscribers.delete(id);
        }
        this.socketDevices.delete(socket);
    }

    publishMetric(deviceId: string, snapshot: MetricSnapshot): void {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const frame = metricFrame(deviceId, snapshot);
        for (const socket of set) socket.send(frame);
    }

    publishReport(deviceId: string, report: DeviceReport): void {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const frame = reportFrame(deviceId, report);
        for (const socket of set) socket.send(frame);
    }

    /**
     * Push the most recent metric snapshot / report straight to one socket.
     * Used right after `metrics.subscribe` so the UI shows data immediately
     * instead of waiting for the next live sample.
     */
    sendInitial(
        socket: WebSocket,
        deviceId: string,
        snapshot: MetricSnapshot | null,
        report: DeviceReport | null
    ): void {
        if (snapshot) socket.send(metricFrame(deviceId, snapshot));
        if (report) socket.send(reportFrame(deviceId, report));
    }

    private publishPresence(deviceId: string, online: boolean): void {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const presence: DevicePresence = {
            deviceId,
            online,
            lastSeen: Math.floor(Date.now() / 1000)
        };
        const frame = JSON.stringify({
            command: DEVICE_PRESENCE_EVENT,
            payload: { ok: true, data: presence }
        });
        for (const socket of set) socket.send(frame);
    }
}

function metricFrame(deviceId: string, snapshot: MetricSnapshot): string {
    return JSON.stringify({
        command: METRICS_PUSH_EVENT,
        payload: { ok: true, data: { deviceId, snapshot } }
    });
}

function reportFrame(deviceId: string, report: DeviceReport): string {
    return JSON.stringify({
        command: DEVICE_REPORT_EVENT,
        payload: { ok: true, data: { deviceId, report } }
    });
}

/** Per-connection binding handed to feature handlers via FeatureContext. */
export interface MonitorTransport {
    subscribe(deviceIds: string[]): void;
    unsubscribe(deviceIds: string[]): void;
    isOnline(deviceIds: string[]): Record<string, boolean>;
    /** Push the latest snapshot/report for one device straight to this socket. */
    sendInitial(deviceId: string, snapshot: MetricSnapshot | null, report: DeviceReport | null): void;
    /** Ask the device's agent to push fresh data now; false if it's offline. */
    requestCollect(deviceId: string): boolean;
    /** Push updated collection config to the device's agent; false if offline. */
    pushConfig(deviceId: string, config: AgentConfigPayload): boolean;
}

export function createMonitorTransport(hub: MonitorHub, socket: WebSocket): MonitorTransport {
    return {
        subscribe: (deviceIds) => hub.subscribe(socket, deviceIds),
        unsubscribe: (deviceIds) => hub.unsubscribe(socket, deviceIds),
        isOnline: (deviceIds) => hub.onlineDevices(deviceIds),
        sendInitial: (deviceId, snapshot, report) => hub.sendInitial(socket, deviceId, snapshot, report),
        requestCollect: (deviceId) => hub.requestCollect(deviceId),
        pushConfig: (deviceId, config) => hub.pushConfig(deviceId, config)
    };
}

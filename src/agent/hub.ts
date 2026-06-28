import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_COLLECT,
    AGENT_CONFIG,
    AGENT_DESTROY,
    AGENT_PKG_LIST,
    AGENT_PKG_UPGRADE,
    AGENT_POWER,
    AGENT_SERVICE,
    AGENT_UPDATE,
    DEVICE_POWER_EVENT,
    DEVICE_PRESENCE_EVENT,
    DEVICE_REPORT_EVENT,
    METRICS_PUSH_EVENT,
    PACKAGE_DONE_EVENT,
    PACKAGE_LIST_EVENT,
    PACKAGE_PROGRESS_EVENT,
    type AgentConfigPayload,
    type AgentPkgUpgradePayload,
    type AgentPowerPayload,
    type AgentServicePayload,
    type AgentUpdatePayload,
    type DevicePowerPush,
    type DevicePresence,
    type DeviceReport,
    type MetricSnapshot,
    type PackageDonePush,
    type PackageListPush,
    type PackageProgressPush
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

    agentOffline(deviceId: string, socket: WebSocket): void {
        // Only forget the agent if the socket closing is the one we still hold. A
        // fast reconnect — or a self-update relaunch — may have already replaced it,
        // and a late close from the *old* socket must not evict the new one (which
        // would leave a live agent wrongly marked offline until its next reconnect).
        if (this.agents.get(deviceId) !== socket) return;
        this.agents.delete(deviceId);
        this.publishPresence(deviceId, false);
    }

    isOnline(deviceId: string): boolean {
        return this.agents.has(deviceId);
    }

    /**
     * Send one command frame to a device's connected agent. Returns false (a no-op)
     * when the agent is offline — every `requestX`/`pushConfig` below is a thin,
     * self-documenting wrapper over this so they all share the offline semantics.
     */
    private sendToAgent(deviceId: string, command: string, payload: unknown = {}): boolean {
        const socket = this.agents.get(deviceId);
        if (!socket) return false;
        socket.send(JSON.stringify({ command, payload }));
        return true;
    }

    /** Ask a connected agent to push a fresh sample + report now. No-op if offline. */
    requestCollect(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_COLLECT);
    }

    /** Push updated collection config to a connected agent. No-op if offline. */
    pushConfig(deviceId: string, config: AgentConfigPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_CONFIG, config);
    }

    /** Tell a connected agent to self-destruct now. No-op if offline. */
    requestDestroy(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_DESTROY);
    }

    /** Order a connected agent to self-update to a newer signed binary. No-op if offline. */
    requestUpdate(deviceId: string, payload: AgentUpdatePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_UPDATE, payload);
    }

    /** Ask a connected agent to change its persistence/privilege install. No-op if offline. */
    requestService(deviceId: string, payload: AgentServicePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SERVICE, payload);
    }

    /** Ask a connected agent to enumerate its package managers. No-op if offline. */
    requestPkgList(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_PKG_LIST);
    }

    /** Ask a connected agent to apply a manager's updates. No-op if offline. */
    requestPkgUpgrade(deviceId: string, payload: AgentPkgUpgradePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_PKG_UPGRADE, payload);
    }

    /** Ask a connected agent to run a system power action (shutdown/reboot…). No-op if offline. */
    requestPower(deviceId: string, payload: AgentPowerPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_POWER, payload);
    }

    /** Fan out a system power-action outcome to the device's subscribers. */
    publishPower(payload: DevicePowerPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_POWER_EVENT, payload);
    }

    /** Fan out a package-manager inventory to the device's subscribers. */
    publishPackageList(payload: PackageListPush): void {
        this.publishToSubscribers(payload.deviceId, PACKAGE_LIST_EVENT, payload);
    }

    /** Fan out one live upgrade-progress line to the device's subscribers. */
    publishPackageProgress(payload: PackageProgressPush): void {
        this.publishToSubscribers(payload.deviceId, PACKAGE_PROGRESS_EVENT, payload);
    }

    /** Fan out an upgrade completion to the device's subscribers. */
    publishPackageDone(payload: PackageDonePush): void {
        this.publishToSubscribers(payload.deviceId, PACKAGE_DONE_EVENT, payload);
    }

    private publishToSubscribers(deviceId: string, command: string, data: unknown): void {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const frame = JSON.stringify({ command, payload: { ok: true, data } });
        for (const socket of set) socket.send(frame);
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
    /** Tell the device's agent to self-destruct now; false if offline. */
    requestDestroy(deviceId: string): boolean;
    /** Order the device's agent to self-update; false if offline. */
    requestUpdate(deviceId: string, payload: AgentUpdatePayload): boolean;
    /** Ask the device's agent to change its persistence/privilege install; false if offline. */
    requestService(deviceId: string, payload: AgentServicePayload): boolean;
    /** Ask the device's agent to enumerate package managers; false if offline. */
    requestPkgList(deviceId: string): boolean;
    /** Ask the device's agent to apply a manager's updates; false if offline. */
    requestPkgUpgrade(deviceId: string, payload: AgentPkgUpgradePayload): boolean;
    /** Ask the device's agent to run a system power action; false if offline. */
    requestPower(deviceId: string, payload: AgentPowerPayload): boolean;
}

export function createMonitorTransport(hub: MonitorHub, socket: WebSocket): MonitorTransport {
    return {
        subscribe: (deviceIds) => hub.subscribe(socket, deviceIds),
        unsubscribe: (deviceIds) => hub.unsubscribe(socket, deviceIds),
        isOnline: (deviceIds) => hub.onlineDevices(deviceIds),
        sendInitial: (deviceId, snapshot, report) => hub.sendInitial(socket, deviceId, snapshot, report),
        requestCollect: (deviceId) => hub.requestCollect(deviceId),
        pushConfig: (deviceId, config) => hub.pushConfig(deviceId, config),
        requestDestroy: (deviceId) => hub.requestDestroy(deviceId),
        requestUpdate: (deviceId, payload) => hub.requestUpdate(deviceId, payload),
        requestService: (deviceId, payload) => hub.requestService(deviceId, payload),
        requestPkgList: (deviceId) => hub.requestPkgList(deviceId),
        requestPkgUpgrade: (deviceId, payload) => hub.requestPkgUpgrade(deviceId, payload),
        requestPower: (deviceId, payload) => hub.requestPower(deviceId, payload)
    };
}

import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_COLLECT,
    AGENT_CONFIG,
    AGENT_DESTROY,
    AGENT_FILES_ANALYZE,
    AGENT_FILES_DOWNLOAD,
    AGENT_FILES_LIST,
    AGENT_FILES_MUTATE,
    AGENT_FILES_SEARCH,
    AGENT_FILES_UPLOAD,
    AGENT_LOG_QUERY,
    AGENT_LOG_SOURCES,
    AGENT_PKG_LIST,
    AGENT_PKG_UPGRADE,
    AGENT_POWER,
    AGENT_SERVICE,
    AGENT_SYNC_APPLY_CHUNK,
    AGENT_SYNC_CONFIG,
    AGENT_SYNC_DELETE,
    AGENT_SYNC_PUSH,
    AGENT_SYNC_SCAN,
    AGENT_TERM_CLOSE,
    AGENT_TERM_INPUT,
    AGENT_TERM_OPEN,
    AGENT_TERM_RESIZE,
    AGENT_UPDATE,
    CLOUD_SYNC_CHUNK_EVENT,
    CLOUD_SYNC_PROGRESS_EVENT,
    CLOUD_SYNC_STATE_EVENT,
    DEVICE_FILES_CHUNK_EVENT,
    DEVICE_FILES_LISTING_EVENT,
    DEVICE_FILES_MATCHES_EVENT,
    DEVICE_FILES_OP_EVENT,
    DEVICE_FILES_USAGE_EVENT,
    DEVICE_LOG_LINES_EVENT,
    DEVICE_LOG_SOURCES_EVENT,
    DEVICE_POWER_EVENT,
    DEVICE_PRESENCE_EVENT,
    DEVICE_REPORT_EVENT,
    DEVICE_TERM_EXIT_EVENT,
    DEVICE_TERM_OUTPUT_EVENT,
    METRICS_PUSH_EVENT,
    PACKAGE_DONE_EVENT,
    PACKAGE_LIST_EVENT,
    PACKAGE_PROGRESS_EVENT,
    type AgentConfigPayload,
    type AgentFilesAnalyzePayload,
    type AgentFilesDownloadPayload,
    type AgentFilesListPayload,
    type AgentFilesMutatePayload,
    type AgentFilesSearchPayload,
    type AgentFilesUploadPayload,
    type AgentLogQueryPayload,
    type AgentPkgUpgradePayload,
    type AgentPowerPayload,
    type AgentServicePayload,
    type AgentSyncApplyChunkPayload,
    type AgentSyncConfigPayload,
    type AgentSyncDeletePayload,
    type AgentSyncPushPayload,
    type AgentSyncScanPayload,
    type AgentTermClosePayload,
    type AgentTermInputPayload,
    type AgentTermOpenPayload,
    type AgentTermResizePayload,
    type AgentUpdatePayload,
    type CloudSyncChunkPush,
    type CloudSyncProgressPush,
    type CloudSyncStatePush,
    type DeviceFilesChunkPush,
    type DeviceFilesListingPush,
    type DeviceFilesMatchesPush,
    type DeviceFilesOpPush,
    type DeviceFilesUsagePush,
    type DeviceLogLinesPush,
    type DeviceLogSourcesPush,
    type DevicePowerPush,
    type DevicePresence,
    type DeviceReport,
    type DeviceTermExitPush,
    type DeviceTermOutputPush,
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
    /** shareId (CloudSync) -> set of subscriber (user) sockets. */
    private readonly syncSubscribers = new Map<number, Set<WebSocket>>();
    /** subscriber socket -> set of shareIds it watches (for cleanup). */
    private readonly socketShares = new Map<WebSocket, Set<number>>();

    agentOnline(deviceId: string, socket: WebSocket): void {
        // One live session per device. Without this, a superseded socket (fast
        // reconnect, or a *duplicate agent instance* sharing the enrollment)
        // kept streaming its own snapshots alongside the new one — doubled
        // telemetry with no error anywhere. 1012 = "service restart": the old
        // agent treats it as a clean close and backs off before redialing.
        const prev = this.agents.get(deviceId);
        if (prev && prev !== socket) prev.close(1012, 'Session replaced by a newer agent connection');
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

    /** Ask a connected agent to enumerate its log sources. No-op if offline. */
    requestLogSources(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_LOG_SOURCES);
    }

    /** Ask a connected agent to run one log query. No-op if offline. */
    requestLogQuery(deviceId: string, payload: AgentLogQueryPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_LOG_QUERY, payload);
    }

    /** Fan out a device's log-source inventory to its subscribers. */
    publishLogSources(payload: DeviceLogSourcesPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_LOG_SOURCES_EVENT, payload);
    }

    /** Fan out one chunk of queried log lines to a device's subscribers. */
    publishLogLines(payload: DeviceLogLinesPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_LOG_LINES_EVENT, payload);
    }

    /** Open an interactive terminal session on a connected agent. No-op if offline. */
    requestTermOpen(deviceId: string, payload: AgentTermOpenPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_TERM_OPEN, payload);
    }

    /** Send terminal input to a connected agent. No-op if offline. */
    requestTermInput(deviceId: string, payload: AgentTermInputPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_TERM_INPUT, payload);
    }

    /** Resize a terminal session on a connected agent. No-op if offline. */
    requestTermResize(deviceId: string, payload: AgentTermResizePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_TERM_RESIZE, payload);
    }

    /** Close a terminal session on a connected agent. No-op if offline. */
    requestTermClose(deviceId: string, payload: AgentTermClosePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_TERM_CLOSE, payload);
    }

    /** Fan out a chunk of terminal output to a device's subscribers. */
    publishTermOutput(payload: DeviceTermOutputPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_TERM_OUTPUT_EVENT, payload);
    }

    /** Fan out a terminal session-end to a device's subscribers. */
    publishTermExit(payload: DeviceTermExitPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_TERM_EXIT_EVENT, payload);
    }

    /** Ask a connected agent to list a directory. No-op if offline. */
    requestFilesList(deviceId: string, payload: AgentFilesListPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_FILES_LIST, payload);
    }

    /** Ask a connected agent to analyse a directory's usage. No-op if offline. */
    requestFilesAnalyze(deviceId: string, payload: AgentFilesAnalyzePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_FILES_ANALYZE, payload);
    }

    /** Ask a connected agent to search a directory. No-op if offline. */
    requestFilesSearch(deviceId: string, payload: AgentFilesSearchPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_FILES_SEARCH, payload);
    }

    /** Ask a connected agent to mutate the filesystem. No-op if offline. */
    requestFilesMutate(deviceId: string, payload: AgentFilesMutatePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_FILES_MUTATE, payload);
    }

    /** Fan out a directory listing to a device's subscribers. */
    publishFilesListing(payload: DeviceFilesListingPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_FILES_LISTING_EVENT, payload);
    }

    /** Fan out a directory usage analysis to a device's subscribers. */
    publishFilesUsage(payload: DeviceFilesUsagePush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_FILES_USAGE_EVENT, payload);
    }

    /** Fan out file search hits to a device's subscribers. */
    publishFilesMatches(payload: DeviceFilesMatchesPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_FILES_MATCHES_EVENT, payload);
    }

    /** Fan out a filesystem mutation outcome to a device's subscribers. */
    publishFilesOp(payload: DeviceFilesOpPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_FILES_OP_EVENT, payload);
    }

    /** Ask a connected agent to download a file (streams chunks). No-op if offline. */
    requestFilesDownload(deviceId: string, payload: AgentFilesDownloadPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_FILES_DOWNLOAD, payload);
    }

    /** Send one upload chunk to a connected agent. No-op if offline. */
    requestFilesUpload(deviceId: string, payload: AgentFilesUploadPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_FILES_UPLOAD, payload);
    }

    /** Fan out one chunk of a downloaded file to a device's subscribers. */
    publishFilesChunk(payload: DeviceFilesChunkPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_FILES_CHUNK_EVENT, payload);
    }

    /** Push a device's CloudSync assignments to its agent. No-op if offline. */
    requestSyncConfig(deviceId: string, payload: AgentSyncConfigPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_CONFIG, payload);
    }

    /** Ask a connected agent to scan a share's local folder. No-op if offline. */
    requestSyncScan(deviceId: string, payload: AgentSyncScanPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_SCAN, payload);
    }

    /** Ask a connected agent to upload one file (streams `sync.chunk`). No-op if offline. */
    requestSyncPush(deviceId: string, payload: AgentSyncPushPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_PUSH, payload);
    }

    /** Send one download chunk for the agent to install. No-op if offline. */
    requestSyncApplyChunk(deviceId: string, payload: AgentSyncApplyChunkPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_APPLY_CHUNK, payload);
    }

    /** Propagate a deletion (local recycle) to a connected agent. No-op if offline. */
    requestSyncDelete(deviceId: string, payload: AgentSyncDeletePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_DELETE, payload);
    }

    /** Fan out CloudSync session progress to the share's subscribers. */
    publishSyncProgress(payload: CloudSyncProgressPush): void {
        this.publishToSyncSubscribers(payload.shareId, CLOUD_SYNC_PROGRESS_EVENT, payload);
    }

    /** Fan out a share's aggregated state to its subscribers. */
    publishSyncState(payload: CloudSyncStatePush): void {
        this.publishToSyncSubscribers(payload.shareId, CLOUD_SYNC_STATE_EVENT, payload);
    }

    /** Send one CloudSync download chunk to the requesting socket only.
     *  Returns the socket's send-buffer size so the caller can apply backpressure. */
    sendSyncChunk(socket: WebSocket, payload: CloudSyncChunkPush): number {
        socket.send(JSON.stringify({ command: CLOUD_SYNC_CHUNK_EVENT, payload: { ok: true, data: payload } }));
        return socket.bufferedAmount;
    }

    subscribeSync(socket: WebSocket, shareIds: number[]): void {
        let watched = this.socketShares.get(socket);
        if (!watched) {
            watched = new Set();
            this.socketShares.set(socket, watched);
        }
        for (const id of shareIds) {
            watched.add(id);
            let set = this.syncSubscribers.get(id);
            if (!set) {
                set = new Set();
                this.syncSubscribers.set(id, set);
            }
            set.add(socket);
        }
    }

    unsubscribeSync(socket: WebSocket, shareIds: number[]): void {
        const watched = this.socketShares.get(socket);
        for (const id of shareIds) {
            watched?.delete(id);
            const set = this.syncSubscribers.get(id);
            set?.delete(socket);
            if (set && set.size === 0) this.syncSubscribers.delete(id);
        }
    }

    private publishToSyncSubscribers(shareId: number, command: string, data: unknown): void {
        const set = this.syncSubscribers.get(shareId);
        if (!set || set.size === 0) return;
        const frame = JSON.stringify({ command, payload: { ok: true, data } });
        for (const socket of set) socket.send(frame);
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
        if (watched) {
            for (const id of watched) {
                const set = this.subscribers.get(id);
                set?.delete(socket);
                if (set && set.size === 0) this.subscribers.delete(id);
            }
            this.socketDevices.delete(socket);
        }
        const shares = this.socketShares.get(socket);
        if (shares) {
            for (const id of shares) {
                const set = this.syncSubscribers.get(id);
                set?.delete(socket);
                if (set && set.size === 0) this.syncSubscribers.delete(id);
            }
            this.socketShares.delete(socket);
        }
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
    /** Ask the device's agent to enumerate its log sources; false if offline. */
    requestLogSources(deviceId: string): boolean;
    /** Ask the device's agent to run one log query; false if offline. */
    requestLogQuery(deviceId: string, payload: AgentLogQueryPayload): boolean;
    /** Open a terminal session on the device's agent; false if offline. */
    requestTermOpen(deviceId: string, payload: AgentTermOpenPayload): boolean;
    /** Send terminal input to the device's agent; false if offline. */
    requestTermInput(deviceId: string, payload: AgentTermInputPayload): boolean;
    /** Resize a terminal session on the device's agent; false if offline. */
    requestTermResize(deviceId: string, payload: AgentTermResizePayload): boolean;
    /** Close a terminal session on the device's agent; false if offline. */
    requestTermClose(deviceId: string, payload: AgentTermClosePayload): boolean;
    /** Ask the device's agent to list a directory; false if offline. */
    requestFilesList(deviceId: string, payload: AgentFilesListPayload): boolean;
    /** Ask the device's agent to analyse a directory's usage; false if offline. */
    requestFilesAnalyze(deviceId: string, payload: AgentFilesAnalyzePayload): boolean;
    /** Ask the device's agent to search a directory; false if offline. */
    requestFilesSearch(deviceId: string, payload: AgentFilesSearchPayload): boolean;
    /** Ask the device's agent to mutate the filesystem; false if offline. */
    requestFilesMutate(deviceId: string, payload: AgentFilesMutatePayload): boolean;
    /** Ask the device's agent to download a file; false if offline. */
    requestFilesDownload(deviceId: string, payload: AgentFilesDownloadPayload): boolean;
    /** Send one upload chunk to the device's agent; false if offline. */
    requestFilesUpload(deviceId: string, payload: AgentFilesUploadPayload): boolean;
    /** Subscribe this socket to CloudSync events of the given shares. */
    subscribeSync(shareIds: number[]): void;
    /** Unsubscribe this socket from CloudSync events of the given shares. */
    unsubscribeSync(shareIds: number[]): void;
    /** Send one CloudSync download chunk to this socket; returns the send-buffer size. */
    sendSyncChunk(payload: CloudSyncChunkPush): number;
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
        requestPower: (deviceId, payload) => hub.requestPower(deviceId, payload),
        requestLogSources: (deviceId) => hub.requestLogSources(deviceId),
        requestLogQuery: (deviceId, payload) => hub.requestLogQuery(deviceId, payload),
        requestTermOpen: (deviceId, payload) => hub.requestTermOpen(deviceId, payload),
        requestTermInput: (deviceId, payload) => hub.requestTermInput(deviceId, payload),
        requestTermResize: (deviceId, payload) => hub.requestTermResize(deviceId, payload),
        requestTermClose: (deviceId, payload) => hub.requestTermClose(deviceId, payload),
        requestFilesList: (deviceId, payload) => hub.requestFilesList(deviceId, payload),
        requestFilesAnalyze: (deviceId, payload) => hub.requestFilesAnalyze(deviceId, payload),
        requestFilesSearch: (deviceId, payload) => hub.requestFilesSearch(deviceId, payload),
        requestFilesMutate: (deviceId, payload) => hub.requestFilesMutate(deviceId, payload),
        requestFilesDownload: (deviceId, payload) => hub.requestFilesDownload(deviceId, payload),
        requestFilesUpload: (deviceId, payload) => hub.requestFilesUpload(deviceId, payload),
        subscribeSync: (shareIds) => hub.subscribeSync(socket, shareIds),
        unsubscribeSync: (shareIds) => hub.unsubscribeSync(socket, shareIds),
        sendSyncChunk: (payload) => hub.sendSyncChunk(socket, payload)
    };
}

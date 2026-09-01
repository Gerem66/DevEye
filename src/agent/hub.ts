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
    AGENT_LIFECYCLE,
    AGENT_LOG_QUERY,
    AGENT_DOCKER_ACTION,
    AGENT_DOCKER_INVENTORY,
    AGENT_DOCKER_STATS,
    AGENT_LOG_SOURCES,
    AGENT_PKG_LIST,
    AGENT_PKG_UPGRADE,
    AGENT_POWER,
    AGENT_SCAN,
    AGENT_SERVICE,
    AGENT_SYNC_APPLY_CHUNK,
    AGENT_SYNC_APPLY_DIR,
    AGENT_SYNC_APPLY_START,
    AGENT_SYNC_APPLY_LOCAL,
    AGENT_SYNC_CONFIG,
    AGENT_SYNC_DELETE,
    AGENT_SYNC_MOVE,
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
    DEVICE_DOCKER_DONE_EVENT,
    DEVICE_DOCKER_INVENTORY_EVENT,
    DEVICE_DOCKER_PROGRESS_EVENT,
    DEVICE_DOCKER_STATS_EVENT,
    DEVICE_LOG_SOURCES_EVENT,
    DEVICE_POWER_EVENT,
    DEVICE_PRESENCE_EVENT,
    DEVICE_REPORT_EVENT,
    DEVICE_SERVICE_EVENT,
    DEVICE_TERM_EXIT_EVENT,
    DEVICE_TERM_OUTPUT_EVENT,
    METRICS_PUSH_EVENT,
    PACKAGE_DONE_EVENT,
    PACKAGE_LIST_EVENT,
    PACKAGE_PROGRESS_EVENT,
    PACKAGE_STARTED_EVENT,
    type AgentConfigPayload,
    type AgentFilesAnalyzePayload,
    type AgentFilesDownloadPayload,
    type AgentFilesListPayload,
    type AgentFilesMutatePayload,
    type AgentFilesSearchPayload,
    type AgentFilesUploadPayload,
    type AgentLifecyclePayload,
    type AgentDockerActionPayload,
    type AgentLogQueryPayload,
    type AgentPkgUpgradePayload,
    type AgentPowerPayload,
    type AgentServicePayload,
    type AgentSyncApplyChunkPayload,
    type AgentSyncApplyDirPayload,
    type AgentSyncApplyStartPayload,
    type AgentSyncApplyLocalPayload,
    type AgentSyncConfigPayload,
    type AgentSyncDeletePayload,
    type AgentSyncMovePayload,
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
    type DeviceDockerDonePush,
    type DeviceDockerInventoryPush,
    type DeviceDockerProgressPush,
    type DeviceDockerStatsPush,
    type DockerAction,
    type DeviceLogSourcesPush,
    type DevicePowerPush,
    type DevicePresence,
    type DeviceReport,
    type DeviceServicePush,
    type DeviceTermExitPush,
    type DeviceTermOutputPush,
    type MetricSeriesPoint,
    type ProcessSample,
    type MetricSnapshot,
    type PackageDonePush,
    type PackageListPush,
    type PackageManagerId,
    type PackageProgressPush,
    type PackageStartedPush
} from '@deveye/types';

import { accessEpochNow } from '@/features/_access';
import { logger } from '@/logger';

/**
 * Période du balayage de vivacité des agents. Deux tours sans `pong` ferment la
 * socket, donc la détection tombe dans `[P, 2P]`.
 *
 * Nécessaire malgré la WebSocket : une machine éteinte n'envoie rien, TCP est
 * silencieux au repos, et la socket resterait `ESTABLISHED` des heures, la
 * machine affichée en ligne et avalant les commandes.
 *
 * Seul battement du lien (l'agent ne fait que constater un silence,
 * `SERVER_SILENCE_LIMIT`, qui doit rester au-dessus de `2 × P`) ; une minute
 * reste sous le délai d'inactivité d'un proxy inverse (180 s chez Traefik).
 * Inconditionnel : sauter un ping raccourcirait le silence perçu par l'agent.
 * Plus rapide que `LiveHub` (30 s), à dessein : une socket agent morte coûte
 * plus qu'un fantôme dans une liste de présence.
 */
const AGENT_HEARTBEAT_MS = 60_000;

/**
 * Fenêtre et seuil du signalement de reconnexions en rafale : lien instable, DNS
 * qui bascule, ou instance dupliquée évincée en boucle. Les gardes qui bornent
 * le travail de connexion rendraient sinon ce symptôme invisible.
 */
const RECONNECT_WINDOW_MS = 60 * 60 * 1000;
const RECONNECT_WARN_THRESHOLD = 12;

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
    /**
     * Attentes de verdict d'une opération de fichier lancée hors socket web
     * (une sauvegarde nocturne, sans abonné) : une promesse par `opId`.
     */
    private readonly fileOpWaiters = new Map<string, (result: { ok: boolean; error?: string }) => void>();
    /**
     * Vivacité par socket agent, remise à `true` par `pong` : une machine
     * éteinte n'envoie jamais de `close`, la socket resterait ouverte jusqu'au
     * keepalive TCP du noyau.
     */
    private readonly agentAlive = new Map<WebSocket, boolean>();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    /** deviceId -> set of subscriber (user) sockets. */
    private readonly subscribers = new Map<string, Set<WebSocket>>();
    /** subscriber socket -> set of deviceIds it watches (for cleanup). */
    private readonly socketDevices = new Map<WebSocket, Set<string>>();
    /**
     * Mises à jour de paquets en cours, par appareil : le verrou. Ici et non
     * dans l'écran, « une commande tourne déjà » est un fait de la machine, pas
     * de l'onglet. En mémoire du processus : un redémarrage relâche tout, et les
     * outils refusent les exécutions concurrentes.
     */
    private readonly upgrades = new Map<string, Set<PackageManagerId>>();
    /**
     * L'action Docker longue en cours par appareil (`opId` + action). Une seule
     * à la fois : deux écrans ouverts lanceraient sinon deux `prune` concurrents.
     */
    private readonly dockerOps = new Map<string, { opId: string; action: DockerAction }>();
    /** shareId (CloudSync) -> set of subscriber (user) sockets. */
    private readonly syncSubscribers = new Map<number, Set<WebSocket>>();
    /** subscriber socket -> set of shareIds it watches (for cleanup). */
    private readonly socketShares = new Map<WebSocket, Set<number>>();
    /**
     * Droit de voir les appareils, par socket abonnée, estampillé de l'époque
     * d'accès : un utilisateur retiré d'un espace ne doit plus rien recevoir.
     * Retenu ici plutôt que ré-résolu à la diffusion, qui doit rester synchrone
     * (comme `LiveHub`) ; une époque divergente vaut « aucun droit », et toute
     * commande de l'utilisateur répare l'instantané.
     */
    private readonly grants = new Map<WebSocket, { allowed: boolean; epoch: number }>();
    /** deviceId → connexions comptées sur la fenêtre courante (voir `noteReconnect`). */
    private readonly reconnects = new Map<string, { since: number; count: number }>();

    agentOnline(deviceId: string, socket: WebSocket): void {
        // One live session per device: a superseded socket (fast reconnect, or a
        // duplicate agent instance) would keep streaming alongside the new one.
        // 1012 = "service restart": the old agent backs off before redialing.
        const prev = this.agents.get(deviceId);
        if (prev && prev !== socket) prev.close(1012, 'Session replaced by a newer agent connection');
        this.agents.set(deviceId, socket);
        this.agentAlive.set(socket, true);
        socket.on('pong', () => this.agentAlive.set(socket, true));
        this.noteReconnect(deviceId);
        this.publishPresence(deviceId, true);
    }

    /**
     * Compte les connexions d'un appareil sur une fenêtre glissante et signale
     * les rafales, une seule fois par fenêtre : un agent en boucle inonderait
     * sinon les logs.
     */
    private noteReconnect(deviceId: string): void {
        const now = Date.now();
        const seen = this.reconnects.get(deviceId);
        if (seen === undefined || now - seen.since >= RECONNECT_WINDOW_MS) {
            this.reconnects.set(deviceId, { since: now, count: 1 });
            return;
        }
        seen.count += 1;
        if (seen.count < RECONNECT_WARN_THRESHOLD) return;

        logger.warn(
            { deviceId, connections: seen.count, windowMinutes: Math.round(RECONNECT_WINDOW_MS / 60_000) },
            'Agent reconnecting repeatedly — unstable link, DNS flapping, or a duplicate instance being evicted'
        );
        this.reconnects.set(deviceId, { since: now, count: 0 });
    }

    startHeartbeat(): void {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(() => this.sweepAgents(), AGENT_HEARTBEAT_MS);
        this.heartbeatTimer.unref?.();
    }

    stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private sweepAgents(): void {
        for (const [deviceId, socket] of this.agents) {
            if (this.agentAlive.get(socket) === false) {
                // `terminate()` et non `close()` : une pile TCP morte ne verra
                // jamais la poignée de fermeture. `terminate()` émet malgré tout
                // `close`, donc la comptabilité de présence s'applique.
                try {
                    socket.terminate();
                } catch {
                    /* déjà partie */
                }
                this.agents.delete(deviceId);
                this.agentAlive.delete(socket);
                continue;
            }
            this.agentAlive.set(socket, false);
            try {
                socket.ping();
            } catch {
                this.agents.delete(deviceId);
                this.agentAlive.delete(socket);
            }
        }
    }

    agentOffline(deviceId: string, socket: WebSocket): void {
        // Only forget the agent if the socket closing is the one we still hold: a
        // fast reconnect may have replaced it, and a late close from the old
        // socket must not evict the new one.
        if (this.agents.get(deviceId) !== socket) return;
        this.agents.delete(deviceId);
        this.agentAlive.delete(socket);
        this.publishPresence(deviceId, false);
    }

    isOnline(deviceId: string): boolean {
        return this.agents.has(deviceId);
    }

    /**
     * Send one command frame to a device's connected agent. Returns false (a no-op)
     * when the agent is offline; every `requestX`/`pushConfig` below wraps this.
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

    /**
     * Demande un relevé Sentinelle immédiat (persistance + authentification).
     * Distinct de `requestCollect` : celui-ci empreinte des centaines de fichiers.
     */
    requestScan(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_SCAN);
    }

    /** Push updated collection config to a connected agent. No-op if offline. */
    pushConfig(deviceId: string, config: AgentConfigPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_CONFIG, config);
    }

    /** Tell a connected agent to self-destruct now. No-op if offline. */
    requestDestroy(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_DESTROY);
    }

    /**
     * Coupe la session d'un agent sur-le-champ : la session capture le statut à
     * la connexion, révoquer sans fermer la socket laisserait l'agent écrire
     * jusqu'à sa reconnexion. 1008 (« policy violation ») et non 1012 : l'agent
     * ne doit pas se ruer sur une reconnexion.
     */
    disconnectAgent(deviceId: string): boolean {
        const socket = this.agents.get(deviceId);
        if (!socket) return false;
        socket.close(1008);
        return true;
    }

    /**
     * Coupe la session pour qu'elle se rétablisse avec un statut à jour (un
     * appareil approuvé alors que son agent est déjà connecté). 1012 (« service
     * restart »), pour que l'agent revienne au lieu de renoncer.
     */
    resetAgentSession(deviceId: string): boolean {
        const socket = this.agents.get(deviceId);
        if (!socket) return false;
        socket.close(1012, 'Device configuration changed');
        return true;
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

    /**
     * Re-demande l'inventaire des paquets après une mise à jour aboutie. Ici et
     * une seule fois : chaque écran le demandant de son côté multiplierait les
     * détections. Rien n'est demandé quand personne ne regarde.
     */
    refreshPackagesIfWatched(deviceId: string): void {
        if ((this.subscribers.get(deviceId)?.size ?? 0) === 0) return;
        this.requestPkgList(deviceId);
    }

    /** Les gestionnaires dont une mise à jour tourne, pour cet appareil. */
    runningUpgrades(deviceId: string): PackageManagerId[] {
        return [...(this.upgrades.get(deviceId) ?? [])];
    }

    /** Prend le verrou pour ce gestionnaire ; `false` si une mise à jour y tourne déjà. */
    beginUpgrade(deviceId: string, manager: PackageManagerId): boolean {
        const set = this.upgrades.get(deviceId) ?? new Set<PackageManagerId>();
        if (set.has(manager)) return false;
        set.add(manager);
        this.upgrades.set(deviceId, set);
        return true;
    }

    /** Relâche le verrou (fin de la commande, ou échec de son envoi). */
    endUpgrade(deviceId: string, manager: PackageManagerId): void {
        const set = this.upgrades.get(deviceId);
        if (!set) return;
        set.delete(manager);
        if (set.size === 0) this.upgrades.delete(deviceId);
    }

    /**
     * Clôt d'autorité les mises à jour d'un appareil devenu injoignable : aucun
     * `pkg.done` n'arrivera plus. Échec explicite diffusé, sinon un bouton
     * réactivé sans un mot laisserait croire à un succès.
     */
    failRunningUpgrades(deviceId: string, error: string): void {
        for (const manager of this.runningUpgrades(deviceId)) {
            this.endUpgrade(deviceId, manager);
            this.publishPackageDone({ deviceId, manager, ok: false, error });
        }
    }

    /** Ask a connected agent for its container inventory. No-op if offline. */
    requestDockerInventory(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_DOCKER_INVENTORY);
    }

    /** Ask a connected agent for a one-shot container stats sample. No-op if offline. */
    requestDockerStats(deviceId: string): boolean {
        return this.sendToAgent(deviceId, AGENT_DOCKER_STATS);
    }

    /** Ask a connected agent to act on a container/image/volume/network. No-op if offline. */
    requestDockerAction(deviceId: string, payload: AgentDockerActionPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_DOCKER_ACTION, payload);
    }

    /** L'action Docker longue en cours sur cet appareil, s'il y en a une. */
    runningDockerOp(deviceId: string): string | null {
        return this.dockerOps.get(deviceId)?.opId ?? null;
    }

    /** Prend le verrou d'action longue ; `false` s'il en tourne déjà une. */
    beginDockerOp(deviceId: string, opId: string, action: DockerAction): boolean {
        if (this.dockerOps.has(deviceId)) return false;
        this.dockerOps.set(deviceId, { opId, action });
        return true;
    }

    /** Relâche le verrou (échec de l'envoi ; la fin normale passe par `docker.done`). */
    endDockerOp(deviceId: string, opId: string): void {
        if (this.dockerOps.get(deviceId)?.opId === opId) this.dockerOps.delete(deviceId);
    }

    /**
     * Clôt d'autorité l'action d'un appareil devenu injoignable : aucun
     * `docker.done` n'arrivera plus. Même raison que pour les paquets, un
     * bouton réactivé sans un mot laisserait croire à un succès.
     */
    failRunningDockerOp(deviceId: string, error: string): void {
        const op = this.dockerOps.get(deviceId);
        if (!op) return;
        this.dockerOps.delete(deviceId);
        this.publishDockerDone({ deviceId, opId: op.opId, action: op.action, ok: false, error });
    }

    /** Fan out a device's container inventory to its subscribers. */
    publishDockerInventory(payload: DeviceDockerInventoryPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_DOCKER_INVENTORY_EVENT, payload);
    }

    /** Fan out a container stats sample to a device's subscribers. */
    publishDockerStats(payload: DeviceDockerStatsPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_DOCKER_STATS_EVENT, payload);
    }

    /** Fan out one output line of a running action to a device's subscribers. */
    publishDockerProgress(payload: DeviceDockerProgressPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_DOCKER_PROGRESS_EVENT, payload);
    }

    /** Fan out an action's outcome, releasing its lock on the way. */
    publishDockerDone(payload: DeviceDockerDonePush): void {
        this.endDockerOp(payload.deviceId, payload.opId);
        this.publishToSubscribers(payload.deviceId, DEVICE_DOCKER_DONE_EVENT, payload);
    }

    /** Ask a connected agent to run a system power action (shutdown/reboot…). No-op if offline. */
    requestPower(deviceId: string, payload: AgentPowerPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_POWER, payload);
    }

    /** Ask a connected agent to stop/restart its own process. No-op if offline. */
    requestLifecycle(deviceId: string, payload: AgentLifecyclePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_LIFECYCLE, payload);
    }

    /** Fan out a system power-action outcome to the device's subscribers. */
    publishPower(payload: DevicePowerPush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_POWER_EVENT, payload);
    }

    /** Fan out a persistence/privilege change outcome to the device's subscribers. */
    publishService(payload: DeviceServicePush): void {
        this.publishToSubscribers(payload.deviceId, DEVICE_SERVICE_EVENT, payload);
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
        // Le verdict part aux abonnés et à qui l'attendait par promesse : une
        // sauvegarde lancée depuis un écran doit débloquer le moteur et se voir.
        const waiter = this.fileOpWaiters.get(payload.opId);
        if (waiter) {
            this.fileOpWaiters.delete(payload.opId);
            waiter({ ok: payload.ok, error: payload.error });
        }
        this.publishToSubscribers(payload.deviceId, DEVICE_FILES_OP_EVENT, payload);
    }

    /**
     * Attend le verdict d'une opération de fichier, pour un appelant sans socket.
     * L'échéance est nécessaire : un agent déconnecté en plein dépôt n'enverra
     * jamais de verdict.
     */
    awaitFilesOp(opId: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.fileOpWaiters.delete(opId);
                resolve({ ok: false, error: "L'agent n'a pas répondu dans le délai imparti." });
            }, timeoutMs);
            timer.unref();
            this.fileOpWaiters.set(opId, (result) => {
                clearTimeout(timer);
                resolve(result);
            });
        });
    }

    /** Abandonne une attente (l'agent est tombé, ou l'envoi a échoué en amont). */
    cancelFilesOp(opId: string): void {
        this.fileOpWaiters.delete(opId);
    }

    /**
     * Octets encore en attente d'envoi vers un agent, pour la contre-pression :
     * sans elle, la mémoire du serveur suivrait la taille de l'archive poussée.
     */
    agentBuffered(deviceId: string): number {
        return this.agents.get(deviceId)?.bufferedAmount ?? 0;
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

    /** Ask a connected agent where to resume a download (replies `applyReady`). */
    requestSyncApplyStart(deviceId: string, payload: AgentSyncApplyStartPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_APPLY_START, payload);
    }

    /** Ask a connected agent to create an empty directory (no bytes transferred). */
    requestSyncApplyDir(deviceId: string, payload: AgentSyncApplyDirPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_APPLY_DIR, payload);
    }

    /** Ask a connected agent to install content it already holds at another path. */
    requestSyncApplyLocal(deviceId: string, payload: AgentSyncApplyLocalPayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_APPLY_LOCAL, payload);
    }

    /** Ask a connected agent to rename a file in place (no transfer, no trash). */
    requestSyncMove(deviceId: string, payload: AgentSyncMovePayload): boolean {
        return this.sendToAgent(deviceId, AGENT_SYNC_MOVE, payload);
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

    /**
     * Fan out a package-manager inventory to the device's subscribers, **enrichi**
     * des mises à jour déjà en cours : l'agent énumère ses gestionnaires sans
     * savoir lesquels le serveur a déjà lancés.
     */
    publishPackageList(payload: Omit<PackageListPush, 'running'>): void {
        const running = this.runningUpgrades(payload.deviceId);
        this.publishToSubscribers(payload.deviceId, PACKAGE_LIST_EVENT, { ...payload, running });
    }

    /** Annonce qu'une mise à jour vient d'être acceptée pour ce gestionnaire. */
    publishPackageStarted(payload: PackageStartedPush): void {
        this.publishToSubscribers(payload.deviceId, PACKAGE_STARTED_EVENT, payload);
    }

    /** Fan out one live upgrade-progress line to the device's subscribers. */
    publishPackageProgress(payload: PackageProgressPush): void {
        this.publishToSubscribers(payload.deviceId, PACKAGE_PROGRESS_EVENT, payload);
    }

    /** Fan out an upgrade completion to the device's subscribers. */
    publishPackageDone(payload: PackageDonePush): void {
        this.publishToSubscribers(payload.deviceId, PACKAGE_DONE_EVENT, payload);
    }

    /**
     * Instantané des droits, posé par le dispatcheur à chaque commande.
     * Voir {@link grants}.
     */
    rememberGrants(socket: WebSocket, allowed: boolean, epoch: number): void {
        this.grants.set(socket, { allowed, epoch });
    }

    /**
     * Cette socket a-t-elle *encore* le droit de recevoir ? Refuse par défaut :
     * une socket sans instantané, ou dont l'instantané précède la dernière
     * mutation d'accès, ne reçoit rien tant qu'elle n'a pas prouvé le contraire.
     */
    private mayReceive(socket: WebSocket, epoch: number): boolean {
        const g = this.grants.get(socket);
        return g !== undefined && g.allowed && g.epoch === epoch;
    }

    /**
     * La diffusion vers les navigateurs qui suivent un appareil, filtrée par
     * l'époque d'accès de chaque socket. La trame est construite à la demande :
     * sans abonné, les métriques ne sérialisent rien.
     */
    private fanOut(deviceId: string, buildFrame: () => string): void {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const frame = buildFrame();
        const epoch = accessEpochNow();
        for (const socket of set) {
            if (this.mayReceive(socket, epoch)) socket.send(frame);
        }
    }

    private publishToSubscribers(deviceId: string, command: string, data: unknown): void {
        this.fanOut(deviceId, () => JSON.stringify({ command, payload: { ok: true, data } }));
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
        this.grants.delete(socket);
    }

    publishMetric(deviceId: string, snapshot: MetricSnapshot): void {
        this.fanOut(deviceId, () => metricFrame(deviceId, snapshot));
    }

    publishReport(deviceId: string, report: DeviceReport): void {
        this.fanOut(deviceId, () => reportFrame(deviceId, report));
    }

    /**
     * Push the most recent metric snapshot / report straight to one socket.
     * Used right after `metrics.subscribe` so the UI shows data immediately
     * instead of waiting for the next live sample.
     */
    sendInitial(
        socket: WebSocket,
        deviceId: string,
        point: MetricSeriesPoint | null,
        sample: ProcessSample | null,
        report: DeviceReport | null
    ): void {
        // The point comes from `device_metrics` and the process list from its own
        // table; they are recombined here into the one instant the client expects.
        if (point) {
            const processes = sample && sample.ts === point.timestamp ? sample : null;
            socket.send(
                metricFrame(deviceId, {
                    ...point,
                    processes: processes?.processes ?? null,
                    processKind: processes?.kind ?? null
                })
            );
        }
        if (report) socket.send(reportFrame(deviceId, report));
    }

    private publishPresence(deviceId: string, online: boolean): void {
        this.fanOut(deviceId, () => {
            const presence: DevicePresence = { deviceId, online, lastSeen: Math.floor(Date.now() / 1000) };
            return JSON.stringify({ command: DEVICE_PRESENCE_EVENT, payload: { ok: true, data: presence } });
        });
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
    sendInitial(
        deviceId: string,
        point: MetricSeriesPoint | null,
        sample: ProcessSample | null,
        report: DeviceReport | null
    ): void;
    /** Ask the device's agent to push fresh data now; false if it's offline. */
    requestCollect(deviceId: string): boolean;
    /** Demande un relevé Sentinelle (persistance + auth) ; false si hors ligne. */
    requestScan(deviceId: string): boolean;
    /** Order the device's agent to self-update; false if offline. */
    requestUpdate(deviceId: string, payload: AgentUpdatePayload): boolean;
    /** Ask the device's agent to change its persistence/privilege install; false if offline. */
    requestService(deviceId: string, payload: AgentServicePayload): boolean;
    /** Ask the device's agent to enumerate package managers; false if offline. */
    requestPkgList(deviceId: string): boolean;
    /** Ask the device's agent to apply a manager's updates; false if offline. */
    requestPkgUpgrade(deviceId: string, payload: AgentPkgUpgradePayload): boolean;
    /** Prend le verrou de mise à jour ; `false` s'il en tourne déjà une. */
    beginUpgrade(deviceId: string, manager: PackageManagerId): boolean;
    /** Relâche le verrou (échec de l'envoi ; la fin normale passe par `pkg.done`). */
    endUpgrade(deviceId: string, manager: PackageManagerId): void;
    /** Annonce aux abonnés qu'une mise à jour vient d'être acceptée. */
    publishPackageStarted(payload: PackageStartedPush): void;
    /** Ask the device's agent for its container inventory; false if offline. */
    requestDockerInventory(deviceId: string): boolean;
    /** Ask the device's agent for a container stats sample; false if offline. */
    requestDockerStats(deviceId: string): boolean;
    /** Ask the device's agent to act on a container/image/volume/network; false if offline. */
    requestDockerAction(deviceId: string, payload: AgentDockerActionPayload): boolean;
    /** L'`opId` de l'action Docker longue en cours, s'il y en a une. */
    runningDockerOp(deviceId: string): string | null;
    /** Prend le verrou d'action longue ; `false` s'il en tourne déjà une. */
    beginDockerOp(deviceId: string, opId: string, action: DockerAction): boolean;
    /** Relâche le verrou (échec de l'envoi ; la fin normale passe par `docker.done`). */
    endDockerOp(deviceId: string, opId: string): void;
    /** Ask the device's agent to run a system power action; false if offline. */
    requestPower(deviceId: string, payload: AgentPowerPayload): boolean;
    /** Ask the device's agent to stop/restart its own process; false if offline. */
    requestLifecycle(deviceId: string, payload: AgentLifecyclePayload): boolean;
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
    /** Current send-buffer size, polled while waiting for backpressure to clear. */
    syncChunkBuffered(): number;
}

export function createMonitorTransport(hub: MonitorHub, socket: WebSocket): MonitorTransport {
    return {
        subscribe: (deviceIds) => hub.subscribe(socket, deviceIds),
        unsubscribe: (deviceIds) => hub.unsubscribe(socket, deviceIds),
        isOnline: (deviceIds) => hub.onlineDevices(deviceIds),
        sendInitial: (deviceId, point, sample, report) => hub.sendInitial(socket, deviceId, point, sample, report),
        requestCollect: (deviceId) => hub.requestCollect(deviceId),
        requestScan: (deviceId) => hub.requestScan(deviceId),
        requestUpdate: (deviceId, payload) => hub.requestUpdate(deviceId, payload),
        requestService: (deviceId, payload) => hub.requestService(deviceId, payload),
        requestPkgList: (deviceId) => hub.requestPkgList(deviceId),
        requestPkgUpgrade: (deviceId, payload) => hub.requestPkgUpgrade(deviceId, payload),
        beginUpgrade: (deviceId, manager) => hub.beginUpgrade(deviceId, manager),
        endUpgrade: (deviceId, manager) => hub.endUpgrade(deviceId, manager),
        publishPackageStarted: (payload) => hub.publishPackageStarted(payload),
        requestDockerInventory: (deviceId) => hub.requestDockerInventory(deviceId),
        requestDockerStats: (deviceId) => hub.requestDockerStats(deviceId),
        requestDockerAction: (deviceId, payload) => hub.requestDockerAction(deviceId, payload),
        runningDockerOp: (deviceId) => hub.runningDockerOp(deviceId),
        beginDockerOp: (deviceId, opId, action) => hub.beginDockerOp(deviceId, opId, action),
        endDockerOp: (deviceId, opId) => hub.endDockerOp(deviceId, opId),
        requestPower: (deviceId, payload) => hub.requestPower(deviceId, payload),
        requestLifecycle: (deviceId, payload) => hub.requestLifecycle(deviceId, payload),
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
        sendSyncChunk: (payload) => hub.sendSyncChunk(socket, payload),
        syncChunkBuffered: () => socket.bufferedAmount
    };
}

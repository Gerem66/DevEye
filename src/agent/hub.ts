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
} from 'deveye-types';

import { accessEpochNow } from '@/features/_access';
import { logger } from '@/logger';

/**
 * Période du balayage de vivacité des agents. Deux tours sans `pong` ferment la
 * socket, donc la détection tombe dans `[P, 2P]` : 15 à 30 s ici.
 *
 * C'est le SEUL battement du lien : l'agent n'émet plus le sien, il se contente
 * de constater un silence (`SERVER_SILENCE_LIMIT`). Ce ping et le pong qu'il
 * appelle sont donc, à eux deux, tout le trafic permanent d'un agent au repos.
 * D'où le choix de la cadence : à 10 s, avec un battement dans chaque sens, une
 * flotte immobile produisait vingt-quatre trames par minute et par machine
 * contre huit auparavant — et ça se voyait sur une courbe réseau.
 *
 * DÉLIBÉRÉMENT plus rapide que celui de `LiveHub` (30 s), et il ne faut pas
 * « corriger » la divergence. Les coûts d'une panne ne sont pas comparables :
 * une socket d'agent morte fait passer une machine éteinte pour en ligne et
 * avale en silence les commandes qu'on lui envoie, alors qu'une socket de
 * navigateur morte ne laisse qu'un fantôme dans une liste de présence.
 *
 * `SERVER_SILENCE_LIMIT` (40 s) doit rester nettement au-dessus de `2 × P`,
 * sinon un balayage en retard sous charge ferait reconnecter des agents sains.
 */
const AGENT_HEARTBEAT_MS = 15_000;

/**
 * Fenêtre et seuil du signalement de reconnexions en rafale.
 *
 * Un agent sain se connecte une fois et reste. Au-delà de ce seuil sur cette
 * fenêtre, la machine va mal : lien instable, résolution DNS qui bascule entre
 * deux chemins, ou instance dupliquée qui se fait évincer en boucle.
 *
 * Ça mérite un signalement explicite, parce que les gardes qui bornent le
 * travail de connexion (rapport, relevé Sentinelle) rendent désormais ce
 * symptôme invisible. Les borner sans le dire aurait remplacé un bug voyant par
 * un bug silencieux.
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
     * Vivacité par socket agent, remise à `true` par l'événement `pong`.
     *
     * Sans elle, `online` valait « il y a une socket dans la Map », et rien ne
     * l'en retirait qu'un `close`. Or une machine qu'on éteint n'en envoie
     * jamais : la socket restait à moitié ouverte jusqu'au keepalive TCP du
     * noyau — plus de deux heures — pendant lesquelles l'appareil s'affichait
     * en ligne, acceptait des commandes et les perdait en silence.
     */
    private readonly agentAlive = new Map<WebSocket, boolean>();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    /** deviceId -> set of subscriber (user) sockets. */
    private readonly subscribers = new Map<string, Set<WebSocket>>();
    /** subscriber socket -> set of deviceIds it watches (for cleanup). */
    private readonly socketDevices = new Map<WebSocket, Set<string>>();
    /**
     * Mises à jour de paquets en cours, par appareil — le verrou de la
     * fonctionnalité.
     *
     * Il vit ici, et non dans l'écran qui l'a lancée, parce que « une commande
     * tourne déjà » est un fait de la machine, pas de l'onglet : refermer la
     * fenêtre, rouvrir la fonctionnalité ou être quelqu'un d'autre ne le change
     * pas. Sans lui, la même mise à jour partait autant de fois qu'on cliquait,
     * et les téléchargements se doublaient jusqu'à ce que les verrous des outils
     * eux-mêmes fassent le tri.
     *
     * En mémoire du processus, comme la présence : un redémarrage du serveur
     * relâche tout, ce qui est le bon défaut (mieux vaut un verrou perdu qu'un
     * verrou éternel) et reste sans danger — les outils refusent les exécutions
     * concurrentes.
     */
    private readonly upgrades = new Map<string, Set<PackageManagerId>>();
    /** shareId (CloudSync) -> set of subscriber (user) sockets. */
    private readonly syncSubscribers = new Map<number, Set<WebSocket>>();
    /** subscriber socket -> set of shareIds it watches (for cleanup). */
    private readonly socketShares = new Map<WebSocket, Set<number>>();
    /**
     * Droit de voir les appareils, par socket abonnée, estampillé de l'époque
     * d'accès sous laquelle il a été résolu.
     *
     * Sans ça, un abonnement était acquis une fois pour toutes : la diffusion
     * arrosait l'ensemble des sockets inscrites, et un utilisateur retiré d'un
     * espace — ou dont le rôle venait de perdre `devices` — continuait de
     * recevoir métriques, rapports, **sortie de terminal** et morceaux de
     * fichiers jusqu'à sa déconnexion.
     *
     * Retenu ici plutôt que ré-résolu à la diffusion, exactement comme le fait
     * `LiveHub` : `forWorkspace()` rend une promesse qui peut rejeter, et la
     * diffusion doit rester entièrement synchrone. Une époque divergente vaut
     * « aucun droit », jamais « les droits d'avant » — et n'importe quelle
     * commande de l'utilisateur répare l'instantané.
     */
    private readonly grants = new Map<WebSocket, { allowed: boolean; epoch: number }>();
    /** deviceId → connexions comptées sur la fenêtre courante (voir `noteReconnect`). */
    private readonly reconnects = new Map<string, { since: number; count: number }>();

    agentOnline(deviceId: string, socket: WebSocket): void {
        // One live session per device. Without this, a superseded socket (fast
        // reconnect, or a *duplicate agent instance* sharing the enrollment)
        // kept streaming its own snapshots alongside the new one — doubled
        // telemetry with no error anywhere. 1012 = "service restart": the old
        // agent treats it as a clean close and backs off before redialing.
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
     * les rafales. Aucune table : c'est un symptôme à voir passer dans les logs,
     * pas un historique à conserver.
     *
     * Signalé une seule fois par fenêtre et par appareil (le compteur repart à
     * zéro), sinon un agent en boucle inonderait les logs du message qui dénonce
     * justement une inondation.
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

    /**
     * Démarre le balayage de vivacité. Appelé une fois au démarrage, à côté de
     * celui de `LiveHub`.
     */
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
                // jamais la poignée de fermeture, et la socket resterait un
                // fantôme. `terminate()` émet malgré tout `close`, donc toute la
                // comptabilité de présence existante s'applique sans être
                // dupliquée ici.
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
        // Only forget the agent if the socket closing is the one we still hold. A
        // fast reconnect — or a self-update relaunch — may have already replaced it,
        // and a late close from the *old* socket must not evict the new one (which
        // would leave a live agent wrongly marked offline until its next reconnect).
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

    /**
     * Demande un relevé Sentinelle immédiat (persistance + authentification).
     *
     * Distinct de `requestCollect` exprès : celui-là coûte quelques
     * millisecondes, celui-ci empreinte des centaines de fichiers. Les confondre
     * ferait payer ce prix à chaque « rafraîchir » de la page Monitoring.
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
     * Coupe la session d'un agent, sur-le-champ.
     *
     * La session agent capture le statut de l'appareil **à la connexion**, et le
     * filtre d'ingestion relit cet instantané : révoquer un appareil sans fermer
     * sa socket le laissait écrire métriques et listes de processus jusqu'à sa
     * prochaine reconnexion, c'est-à-dire potentiellement indéfiniment. La
     * révocation doit donc mordre sur la socket, pas seulement sur la ligne.
     *
     * 1008 (« policy violation ») et non 1012 : ce n'est pas un redémarrage, et
     * l'agent ne doit pas se ruer sur une reconnexion — la suivante sera de
     * toute façon refusée à l'authentification.
     */
    disconnectAgent(deviceId: string): boolean {
        const socket = this.agents.get(deviceId);
        if (!socket) return false;
        socket.close(1008);
        return true;
    }

    /**
     * Coupe la session pour qu'elle se rétablisse avec un statut à jour.
     *
     * Le symétrique du problème ci-dessus : approuver un appareil dont l'agent
     * est **déjà** connecté laissait sa session sur l'instantané « pending », et
     * sa télémétrie continuait d'être accusée puis jetée — un appareil approuvé
     * qui n'enregistre rien, sans le moindre message d'erreur. 1012 (« service
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
     * Re-demande l'inventaire des paquets après une mise à jour aboutie, pour
     * que les compteurs cessent d'annoncer des mises à jour déjà appliquées.
     *
     * Ici, et une seule fois : si chaque écran ouvert le demandait de son côté,
     * une machine regardée par trois personnes subirait trois détections — soit,
     * sur certains gestionnaires, plusieurs minutes de sondes redondantes. Le
     * résultat part de toute façon à tous les abonnés. Rien n'est demandé quand
     * personne ne regarde.
     */
    refreshPackagesIfWatched(deviceId: string): void {
        if ((this.subscribers.get(deviceId)?.size ?? 0) === 0) return;
        this.requestPkgList(deviceId);
    }

    /** Les gestionnaires dont une mise à jour tourne, pour cet appareil. */
    runningUpgrades(deviceId: string): PackageManagerId[] {
        return [...(this.upgrades.get(deviceId) ?? [])];
    }

    /**
     * Prend le verrou pour ce gestionnaire. `false` — et rien n'est modifié —
     * quand une mise à jour y tourne déjà : c'est la réponse qu'attend
     * l'appelant pour refuser la commande plutôt que d'en lancer une seconde.
     */
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
     * Clôt d'autorité les mises à jour d'un appareil devenu injoignable.
     *
     * L'agent parti, aucun `pkg.done` n'arrivera plus : sans ça le verrou
     * resterait pour la durée du processus, et le bouton grisé pour toujours. On
     * diffuse un échec explicite, parce qu'un bouton qui se réactive sans un mot
     * laisserait croire que la mise à jour a abouti — elle continue peut-être
     * sur la machine, mais plus personne ne la suit.
     */
    failRunningUpgrades(deviceId: string, error: string): void {
        for (const manager of this.runningUpgrades(deviceId)) {
            this.endUpgrade(deviceId, manager);
            this.publishPackageDone({ deviceId, manager, ok: false, error });
        }
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

    private publishToSubscribers(deviceId: string, command: string, data: unknown): void {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const frame = JSON.stringify({ command, payload: { ok: true, data } });
        const epoch = accessEpochNow();
        for (const socket of set) {
            if (this.mayReceive(socket, epoch)) socket.send(frame);
        }
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
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const frame = metricFrame(deviceId, snapshot);
        const epoch = accessEpochNow();
        for (const socket of set) {
            if (this.mayReceive(socket, epoch)) socket.send(frame);
        }
    }

    publishReport(deviceId: string, report: DeviceReport): void {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const frame = reportFrame(deviceId, report);
        const epoch = accessEpochNow();
        for (const socket of set) {
            if (this.mayReceive(socket, epoch)) socket.send(frame);
        }
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
        const epoch = accessEpochNow();
        for (const socket of set) {
            if (this.mayReceive(socket, epoch)) socket.send(frame);
        }
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
    /** Push updated collection config to the device's agent; false if offline. */
    pushConfig(deviceId: string, config: AgentConfigPayload): boolean;
    /** Tell the device's agent to self-destruct now; false if offline. */
    requestDestroy(deviceId: string): boolean;
    /** Coupe la session de l'agent : la révocation doit mordre tout de suite. */
    disconnectAgent(deviceId: string): boolean;
    /** Coupe la session pour qu'elle revienne avec un statut à jour (approbation). */
    resetAgentSession(deviceId: string): boolean;
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
        pushConfig: (deviceId, config) => hub.pushConfig(deviceId, config),
        requestDestroy: (deviceId) => hub.requestDestroy(deviceId),
        disconnectAgent: (deviceId) => hub.disconnectAgent(deviceId),
        resetAgentSession: (deviceId) => hub.resetAgentSession(deviceId),
        requestUpdate: (deviceId, payload) => hub.requestUpdate(deviceId, payload),
        requestService: (deviceId, payload) => hub.requestService(deviceId, payload),
        requestPkgList: (deviceId) => hub.requestPkgList(deviceId),
        requestPkgUpgrade: (deviceId, payload) => hub.requestPkgUpgrade(deviceId, payload),
        beginUpgrade: (deviceId, manager) => hub.beginUpgrade(deviceId, manager),
        endUpgrade: (deviceId, manager) => hub.endUpgrade(deviceId, manager),
        publishPackageStarted: (payload) => hub.publishPackageStarted(payload),
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

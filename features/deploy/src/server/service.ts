import type { DeploymentRow, DeployStatus, DeployTargetRow, DeployTargetSyncRow } from '../contracts/domain';
import type {
    DevEyeFacade,
    FeatureService,
    FeatureServiceDeps,
    SdkAlert,
    SdkCipher,
    SdkLiveChannel
} from '@deveye/types/sdk/server';

// L'horodatage et la durée des corps d'alerte sont ceux de l'app, partagés par
// tous ses émetteurs : un avis de déploiement horodaté autrement qu'une alerte
// de disponibilité semblerait venir d'un autre produit.
import { formatDuration, formatMoment } from '@/Services/alertCore';

import { composeTargetOf, type ComposeService } from './agent';
import { buildNotice, estimateFromHistory, firstLine } from './notice';
import { PROVIDERS, providerOf, type DeployProviders } from './providers';
import {
    ProviderError,
    type DeployProviderAdapter,
    type ProviderAccess,
    type ProviderTarget,
    type RemoteDeployment,
    type TargetPlace
} from './providers/types';
import type { DeployRepo } from './repo';
import { providerTargetOf, readJson, type StoredDeployment, type StoredTarget } from './_shared';

/**
 * Le rapprochement des cibles de déploiement avec ce que le fournisseur en dit,
 * en tâche de fond : un ticker du SDK qui lance les cibles dues sans les
 * attendre, des chiffres par espace (`deps.cipherFor`). Il rapproche les cibles, pas seulement les
 * lignes déjà en base : un déploiement lancé depuis Dokploy, une CI ou un push
 * apparaît aussi. Voir {@link DeploySync.syncDeployTargets}.
 *
 * Tout est lu et écrit à l'étage ouvert : une cible appartient à l'espace et
 * ce service tourne sans session.
 */

/**
 * Cibles rapprochées à la fois, tout le serveur confondu, et une seule par accès
 * (une cible = un appel tRPC) : une instance lente ou en panne n'occupe qu'une
 * place et ne retarde jamais les cibles d'une autre ; un espace à quarante
 * cibles ne produit pas quarante requêtes d'un coup.
 */
const DEPLOY_CONCURRENCY = 16;

/**
 * Délai d'une lecture de fond. Plus court que celui d'un geste : une instance
 * qui met plus longtemps à répondre garde sa place en vol, pas celle des autres.
 */
const DEPLOY_SYNC_TIMEOUT_MS = 10_000;

/** Plafond du recul d'un accès qui ne répond pas, doublé à chaque échec depuis {@link DEPLOY_MIN_INTERVAL_SECONDS}. */
const DEPLOY_BACKOFF_MAX_SECONDS = 15 * 60;

/**
 * Délai minimal entre deux rapprochements d'une même cible au repos. Une cible
 * qui a un déploiement en vol y échappe et passe à chaque tour.
 */
const DEPLOY_MIN_INTERVAL_SECONDS = 60;

/**
 * Cadence du rapprochement, et donc de modification du message Discord.
 * Discord tolère environ cinq requêtes par deux secondes et par webhook ; on en
 * fait une par déploiement en vol.
 */
const DEPLOY_TICK_SECONDS = 10;

/**
 * Délai de lecture de la queue du journal pendant un déploiement. Court : le
 * flux d'un déploiement en cours ne se referme pas, chaque lecture va au bout
 * de son délai, et trente secondes dépasseraient l'intervalle du tour.
 */
const DEPLOY_LOG_TIMEOUT_MS = 3_000;

/**
 * Lignes d'historique retenues par cible et par tour : un fournisseur rend
 * l'historique complet, et au-delà de la tête ce sont des déploiements anciens,
 * déjà en base.
 */
const DEPLOY_IMPORT_LIMIT = 20;

/**
 * Écart toléré pour rattacher un déploiement local à une ligne du fournisseur
 * quand l'identifiant externe manque : Dokploy n'en rend pas toujours un au
 * déclenchement, GitHub jamais, et c'est la date qui rapproche jusqu'à ce qu'il
 * arrive.
 */
const DEPLOY_MATCH_WINDOW_SECONDS = 120;

/**
 * Âge au-delà duquel un déploiement local que le fournisseur ne reconnaît pas
 * cesse d'être en vol : sinon une ligne dont il n'a jamais rendu la trace
 * reste `queued` et garde sa cible dans la voie rapide pour toujours. Six
 * heures, pour ne jamais couper un déploiement réellement long.
 */
const DEPLOY_STALE_SECONDS = 6 * 3600;

/** Un déploiement dont l'issue est connue : c'est ce qui mérite un avis. */
function isTerminal(status: string): boolean {
    return status === 'success' || status === 'failed';
}

/**
 * Retrouve la ligne locale que décrit une entrée du fournisseur : par
 * identifiant externe d'abord, par date seulement pour les lignes qui n'en ont
 * pas encore (`deploy.trigger` écrit avant d'appeler le fournisseur). `claimed`
 * interdit qu'une ligne serve deux fois dans le tour.
 */
function matchDeployment(entry: RemoteDeployment, local: DeploymentRow[], claimed: Set<number>): DeploymentRow | null {
    if (entry.externalId !== null) {
        const byId = local.find((row) => row.external_id === entry.externalId && !claimed.has(row.id));
        if (byId) return byId;
    }
    return (
        local.find(
            (row) =>
                row.external_id === null &&
                !claimed.has(row.id) &&
                Math.abs(entry.startedAt - Number(row.started_at)) < DEPLOY_MATCH_WINDOW_SECONDS
        ) ?? null
    );
}

/** Ce qu'un tour a résolu : la ligne locale, et ce que le fournisseur en dit. */
interface SeenDeployment {
    row: DeploymentRow;
    entry: RemoteDeployment;
}

/** Ce qui nourrit le message vivant d'une cible : son journal, son lieu, son dépôt. */
type NoticeSource = Pick<DeployProviderAdapter, 'noticeLog' | 'place' | 'repoUrl'>;

/** Une cible au travail : ce qui nourrit son avis, son accès ouvert, ce qu'elle désigne, son nom. */
interface OpenTarget {
    row: DeployTargetSyncRow;
    notices: NoticeSource;
    access: ProviderAccess;
    spec: ProviderTarget;
    name: string;
}

/** La fin du journal d'une machine que le module retient : ce que l'avis montre et ce que la base garde. */
const AGENT_LOG_MAX_CHARS = 64 * 1024;

/** Un déploiement par une machine, confié au suivi par `deploy.trigger`. */
export interface AgentJob {
    target: DeployTargetRow;
    deploymentId: number;
    service: ComposeService;
}

interface AgentRun {
    job: AgentJob;
    name: string;
    /** La fin du journal, bornée à {@link AGENT_LOG_MAX_CHARS}. */
    lines: string[];
    chars: number;
    /** Les messages vivants d'un déploiement s'écrivent l'un après l'autre. */
    noticing: Promise<void>;
    /** Une mise à jour attend déjà son tour : elle lira l'état le plus frais, inutile d'en ajouter une. */
    queued: boolean;
}

function keepLine(run: AgentRun, line: string): void {
    run.lines.push(line);
    run.chars += line.length + 1;
    while (run.chars > AGENT_LOG_MAX_CHARS && run.lines.length > 1) {
        run.chars -= (run.lines.shift()?.length ?? 0) + 1;
    }
}

/** Ce que l'avis en texte dit d'un déploiement conclu. */
interface LandedDeployment {
    status: string;
    title: string;
    description: string;
    startedAt: number;
    finishedAt: number | null;
}

export class DeploySync {
    /** La boucle du rapprochement : un ticker du SDK. */
    private readonly ticker: FeatureService;
    /**
     * Garde de ré-entrance du choix des cibles : `wake()` déclenche un tour hors
     * cadence, et deux choix concurrents lanceraient deux fois la même cible.
     */
    private ticking: Promise<void> | null = null;

    /**
     * Les rapprochements en vol, par cible, et les accès qu'ils occupent. Une
     * cible en vol n'est pas relancée : deux passes sur la même cible
     * publieraient deux messages pour le même déploiement.
     */
    private readonly running = new Map<number, Promise<void>>();
    private readonly busyCredentials = new Set<number>();

    /**
     * Accès en recul, jusqu'à `until`. En mémoire : c'est l'état d'une instance
     * injoignable depuis ce processus, et écrire dans `synced_at` un
     * rapprochement qui n'a pas eu lieu ferait passer le premier import pour
     * fait. Par accès et non par cible : c'est l'instance qui ne répond pas, et
     * ses cibles en vol ne doivent plus occuper la tête de file.
     */
    private readonly credentialBackoff = new Map<number, { until: number; delay: number }>();

    /** Les déploiements par une machine en cours, par ligne de déploiement. */
    private readonly agentRuns = new Map<number, AgentRun>();
    private readonly agentJobs = new Set<Promise<void>>();

    constructor(
        private readonly deps: FeatureServiceDeps<DeployRepo>,
        /** Les fournisseurs, remplaçables : un test simule une instance sans réseau. */
        private readonly providers: DeployProviders = PROVIDERS
    ) {
        this.ticker = deps.createTicker({ intervalMs: DEPLOY_TICK_SECONDS * 1000, tick: () => this.tick() });
    }

    start(): void {
        this.ticker.start();
        void this.recover().catch((e: unknown) =>
            this.deps.logger.warn({ err: e }, 'Deploy sync: reprise des déploiements par machine en échec')
        );
        this.deps.logger.info({ tickSeconds: DEPLOY_TICK_SECONDS }, 'Deploy sync started');
    }

    /**
     * L'arrêt attend les rapprochements, pas les déploiements par une machine :
     * ceux-là durent jusqu'à trente minutes, et le prochain démarrage les
     * reprend ({@link recover}).
     */
    async stop(): Promise<void> {
        await this.ticker.stop();
        await this.ticking;
        while (this.running.size > 0) await Promise.allSettled(this.running.values());
    }

    /** Rend la main quand plus rien n'est en cours : rapprochements et déploiements par une machine. */
    async idle(): Promise<void> {
        while (this.running.size > 0 || this.agentJobs.size > 0) {
            await Promise.allSettled([...this.running.values(), ...this.agentJobs]);
        }
    }

    /**
     * Les déploiements par une machine restés en vol : leur attente vivait dans
     * le processus précédent, plus personne ne recevra leur verdict. Marqués en
     * échec, sans avis : l'issue sur la machine n'est pas connue.
     */
    async recover(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        for (const row of await this.deps.repo.listInFlightAgentDeployments()) {
            if (this.agentRuns.has(row.id)) continue;
            const cipher = this.deps.cipherFor(row.workspace_id);
            const body = (await readJson<Record<string, unknown>>(cipher, row.content)) ?? {};
            await this.deps.repo.updateDeployment(row.id, {
                externalId: row.external_id,
                status: 'failed',
                finishedAt: now,
                content: await cipher.encrypt(
                    JSON.stringify({
                        ...body,
                        description:
                            'Suivi interrompu par un redémarrage du serveur : l’issue sur la machine n’est pas connue.'
                    })
                )
            });
            await this.deps.repo.markDeploymentNotified(row.id);
            this.deps.live.changed(row.workspace_id);
        }
    }

    /**
     * Lance un déploiement par une machine sans l'attendre : l'agent récupère
     * l'image du service puis le recrée, et ce suivi recueille ses lignes, tient
     * le message vivant et enregistre le verdict.
     */
    startAgentDeploy(job: AgentJob): void {
        const done: Promise<void> = this.runAgentDeploy(job)
            .catch((e: unknown) =>
                this.deps.logger.error({ err: e, deploymentId: job.deploymentId }, 'Deploy agent: suivi en échec')
            )
            .finally(() => {
                this.agentRuns.delete(job.deploymentId);
                this.agentJobs.delete(done);
            });
        this.agentJobs.add(done);
    }

    /** Le journal d'un déploiement par une machine encore en cours ; `null` s'il n'en tourne aucun pour cette ligne. */
    agentLog(deploymentId: number): string | null {
        return this.agentRuns.get(deploymentId)?.lines.join('\n') ?? null;
    }

    /**
     * Déclenche un tour tout de suite : c'est ce qui ouvre le message de suivi
     * dans la seconde qui suit un déclenchement. La garde de ré-entrance rend
     * l'appel inoffensif s'il en tourne déjà un.
     */
    wake(): void {
        void this.tick();
    }

    /**
     * Un tour : choisir les cibles dues et les lancer, sans attendre qu'elles
     * aboutissent. Le tour suivant reprend ce qui s'est libéré entre-temps.
     */
    private tick(): Promise<void> {
        // Le message vivant d'une machine suit la même cadence que celui d'un
        // fournisseur sondé.
        for (const run of this.agentRuns.values()) void this.refreshAgentNotice(run);
        this.ticking ??= this.syncDeployTargets()
            .catch((e: unknown) => this.deps.logger.error({ err: e }, 'Deploy sync: tick failed'))
            .finally(() => {
                this.ticking = null;
            });
        return this.ticking;
    }

    /**
     * Rapproche les cibles de ce que leur fournisseur en dit. Aucun ne prévient
     * DevEye de lui-même : c'est du sondage, borné par
     * {@link DEPLOY_CONCURRENCY} cibles en vol, {@link DEPLOY_MIN_INTERVAL_SECONDS}
     * entre deux passes d'une cible au repos, {@link DEPLOY_IMPORT_LIMIT} lignes
     * par appel.
     */
    private async syncDeployTargets(): Promise<void> {
        const free = DEPLOY_CONCURRENCY - this.running.size;
        if (free <= 0) return;
        const now = Math.floor(Date.now() / 1000);
        const skip = [
            ...this.busyCredentials,
            ...[...this.credentialBackoff].filter(([, b]) => b.until > now).map(([id]) => id)
        ];
        const due = await this.deps.repo.listTargetsDue(
            free * 4,
            now - DEPLOY_MIN_INTERVAL_SECONDS,
            skip,
            this.deps.pauses.paused('targets').map(Number)
        );

        // Les accès occupés sont déjà écartés par la requête ; reste à n'en
        // prendre qu'une cible par accès dans ce tour.
        const taken = new Set<number>();
        for (const target of due) {
            if (taken.size >= free) break;
            const credentialId = target.credential_id;
            if (credentialId === null || taken.has(credentialId)) continue;
            taken.add(credentialId);
            this.launch(target, credentialId, now);
        }
    }

    private launch(target: DeployTargetSyncRow, credentialId: number, now: number): void {
        this.busyCredentials.add(credentialId);
        const run = this.syncDeployTarget(target, now)
            .then(() => {
                this.credentialBackoff.delete(credentialId);
            })
            .catch(async (e: unknown) => {
                // Un recul en mémoire plutôt qu'en base : c'est l'instance qui ne
                // répond pas, pas la cible qui a changé. `synced_at` reste à sa
                // valeur, sinon un premier import raté passerait pour fait.
                const previous = this.credentialBackoff.get(credentialId)?.delay ?? 0;
                const delay =
                    previous === 0 ? DEPLOY_MIN_INTERVAL_SECONDS : Math.min(previous * 2, DEPLOY_BACKOFF_MAX_SECONDS);
                // Un fournisseur qui dit quand revenir (limite de débit) est écouté.
                const retryAt = e instanceof ProviderError ? (e.retryAt ?? 0) : 0;
                this.credentialBackoff.set(credentialId, { until: Math.max(now + delay, retryAt), delay });
                this.deps.logger.warn(
                    { err: e instanceof Error ? e.message : String(e), targetId: target.id, retryInSeconds: delay },
                    'Deploy sync: cible non rapprochée'
                );
                await this.sweepUnreachable(target, now).catch((err: unknown) =>
                    this.deps.logger.warn({ err, targetId: target.id }, 'Deploy sync: purge en échec')
                );
            })
            .finally(() => {
                this.running.delete(target.id);
                this.busyCredentials.delete(credentialId);
            });
        this.running.set(target.id, run);
    }

    /**
     * Une cible : lire chez le fournisseur, réconcilier, prévenir de ce qui a
     * atterri. On écrit AVANT de notifier : un avis parti sur un état non
     * enregistré repartirait au tour suivant.
     */
    private async syncDeployTarget(target: DeployTargetSyncRow, now: number): Promise<void> {
        if (target.credential_id === null) return;

        const cipher = this.deps.cipherFor(target.workspace_id);
        const credential = await this.deps.repo.findCredential(target.credential_id, target.workspace_id);
        if (!credential) return;
        const stored = await readJson<Partial<StoredTarget>>(cipher, target.content);
        const provider = providerOf(this.providers, credential.provider);
        const open: OpenTarget = {
            row: target,
            notices: provider,
            access: {
                credentialId: credential.id,
                baseUrl: credential.base_url,
                secret: await cipher.decrypt(credential.secret_enc)
            },
            spec: providerTargetOf(target, stored),
            name: stored?.name ?? target.external_id
        };

        const remote = await provider.history(open.access, open.spec, { timeoutMs: DEPLOY_SYNC_TIMEOUT_MS });

        // Le premier rapprochement garnit sans prévenir : tout l'historique est
        // « nouveau » ce jour-là sans que rien ne vienne de se produire.
        const firstImport = target.synced_at === null;
        const local = await this.deps.repo.listDeployments(target.id, target.workspace_id, DEPLOY_IMPORT_LIMIT * 3);

        const recent = [...remote].sort((a, b) => b.startedAt - a.startedAt).slice(0, DEPLOY_IMPORT_LIMIT);
        /** Lignes locales déjà appariées : une ligne ne vaut que pour un distant. */
        const claimed = new Set<number>();
        /**
         * Ce que ce tour a résolu, lignes appariées et créées : le suivi vivant
         * a besoin des deux, un déploiement encore en cours n'atterrit pas.
         */
        const seen: SeenDeployment[] = [];
        let changed = false;

        for (const entry of recent) {
            const match = matchDeployment(entry, local, claimed);

            if (match) {
                claimed.add(match.id);
                const externalId = entry.externalId ?? match.external_id;
                const finishedAt = entry.finishedAt;
                const settled =
                    match.status === entry.status &&
                    match.external_id === externalId &&
                    (match.finished_at === null ? finishedAt === null : Number(match.finished_at) === finishedAt);

                if (!settled) {
                    const body = await readJson<Record<string, unknown>>(cipher, match.content);
                    const content = await cipher.encrypt(JSON.stringify({ ...body, description: entry.description }));
                    await this.deps.repo.updateDeployment(match.id, {
                        externalId,
                        status: entry.status,
                        finishedAt,
                        content
                    });
                    // Le message vivant range ses identifiants dans ce blob : il
                    // doit repartir de cette version, pas de celle lue avant.
                    match.content = content;
                    changed = true;
                }
                seen.push({ row: match, entry });
                continue;
            }

            // Inconnu ici : un déploiement parti d'ailleurs, sans auteur, avec la
            // date et l'état du fournisseur.
            const row = await this.deps.repo.createRemoteDeployment({
                targetId: target.id,
                workspaceId: target.workspace_id,
                externalId: entry.externalId,
                status: entry.status,
                startedAt: entry.startedAt,
                finishedAt: entry.finishedAt,
                // Le premier import tait le passé, pas le présent : seul ce qui
                // est déjà terminé entre en base marqué comme annoncé.
                notified: firstImport && isTerminal(entry.status),
                content: await cipher.encrypt(
                    JSON.stringify({
                        title: entry.title,
                        description: entry.description,
                        url: entry.url
                    })
                )
            });
            changed = true;
            seen.push({ row, entry });
        }

        if (
            await this.sweepLost(
                target,
                local,
                claimed,
                now,
                'Suivi perdu : le fournisseur ne connaît plus ce déploiement.'
            )
        ) {
            changed = true;
        }

        await this.deps.repo.markTargetSynced(target.id, now);

        if (changed) {
            // La fiche de la cible et l'onglet du projet suivent `deploy.detail`.
            // Les compteurs d'onglets d'un projet (sujet `projects`, qu'un module
            // ne nomme pas) se relisent à leur prochaine ouverture.
            this.deps.live.changed(target.workspace_id);
        }

        await this.updateDeployNotices({ target: open, history: local, seen, firstImport, now });
    }

    /**
     * Ce que DevEye croit en vol et que le fournisseur ne dit plus (`claimed` :
     * les lignes qu'il a décrites) : passé la borne, c'est un suivi perdu.
     * Marqué `failed` faute d'état inconnu, mais sans avis : annoncer un échec
     * qu'on n'a pas constaté serait pire. Rend vrai si une ligne a changé.
     */
    private async sweepLost(
        target: DeployTargetSyncRow,
        local: DeploymentRow[],
        claimed: ReadonlySet<number>,
        now: number,
        reason: string
    ): Promise<boolean> {
        const cipher = this.deps.cipherFor(target.workspace_id);
        let changed = false;
        for (const row of local) {
            if (claimed.has(row.id) || isTerminal(row.status)) continue;
            if (Number(row.started_at) > now - DEPLOY_STALE_SECONDS) continue;

            const body = await readJson<Record<string, unknown>>(cipher, row.content);
            await this.deps.repo.updateDeployment(row.id, {
                externalId: row.external_id,
                status: 'failed',
                finishedAt: now,
                content: await cipher.encrypt(JSON.stringify({ ...body, description: reason }))
            });
            await this.deps.repo.markDeploymentNotified(row.id);
            changed = true;
        }
        return changed;
    }

    /** Une instance muette ne garde pas ses déploiements « en cours » au-delà de la borne. */
    private async sweepUnreachable(target: DeployTargetSyncRow, now: number): Promise<void> {
        if (Number(target.in_flight) === 0) return;
        const local = await this.deps.repo.listDeployments(target.id, target.workspace_id, DEPLOY_IMPORT_LIMIT * 3);
        if (await this.sweepLost(target, local, new Set(), now, 'Suivi perdu : l’instance ne répond plus.')) {
            this.deps.live.changed(target.workspace_id);
        }
    }

    /**
     * Ouvre, entretient et conclut les messages de suivi d'une cible.
     *
     * Discord est le seul canal qui sache modifier un message envoyé
     * (`notify.postLive`). Un déploiement découvert en vol ouvre un message que
     * les tours suivants modifient jusqu'à la conclusion ; un déploiement trop
     * court pour être vu en vol reçoit le même message, publié une fois. Les
     * autres canaux reçoivent l'avis en texte à l'atterrissage, et un canal
     * dont le message vivant a conclu en est retiré (`except`) : sinon Discord
     * recevrait le message modifié et un second en clair.
     */
    private async updateDeployNotices(input: {
        target: OpenTarget;
        history: DeploymentRow[];
        seen: SeenDeployment[];
        firstImport: boolean;
        now: number;
    }): Promise<void> {
        const { seen, firstImport } = input;
        const target = input.target.row;
        // Passé {@link DEPLOY_STALE_SECONDS}, on cesse d'entretenir le message :
        // un déploiement laissé « en cours » pour toujours ferait sinon une
        // modification Discord toutes les dix secondes, indéfiniment.
        const inFlight = seen.filter(
            (item) => !isTerminal(item.entry.status) && item.entry.startedAt > input.now - DEPLOY_STALE_SECONDS
        );
        // Le premier rapprochement ne conclut jamais (« vient d'atterrir » et
        // « a atterri il y a trois semaines » sont indiscernables ce jour-là) :
        // seule la marque part.
        const landed = seen.filter((item) => isTerminal(item.entry.status) && item.row.notified === 0);
        if (inFlight.length === 0 && landed.length === 0) return;

        const cipher = this.deps.cipherFor(target.workspace_id);
        // La route posée sur la cible décide (deux applications peuvent annoncer
        // dans deux salons) ; les canaux vivants sont ceux qui savent modifier
        // un message.
        const notify = this.deps.deveyeFor(target.workspace_id).notify;
        const live = await notify.liveChannels({ itemId: target.id });
        const name = input.target.name;

        // Les journaux en parallèle par déploiement (chaque lecture va au bout
        // de son délai), jamais par canal d'un même déploiement : ceux-là
        // écrivent tous dans le même blob `noticeIds`.
        if (live.length > 0) {
            await Promise.all(
                inFlight.map((item) =>
                    this.renderNotice({
                        ...input,
                        item,
                        channels: live,
                        notify,
                        cipher,
                        final: false
                    })
                )
            );
        }

        for (const item of landed) {
            if (!firstImport) {
                const closed =
                    live.length > 0
                        ? await this.renderNotice({
                              ...input,
                              item,
                              channels: live,
                              notify,
                              cipher,
                              final: true
                          })
                        : new Set<number>();
                // Un canal dont le message vivant a conclu a déjà tout dit. Les
                // autres reçoivent l'avis en texte par la façade, sur les canaux
                // de Déploiement (jamais ceux d'Uptime). Toujours tenté : la route
                // décide, et la façade ne fait rien sans canal.
                await notify.send(
                    this.deployAlert(name, {
                        status: item.entry.status,
                        title: item.entry.title,
                        description: item.entry.description,
                        startedAt: item.entry.startedAt,
                        finishedAt: item.entry.finishedAt
                    }),
                    { itemId: target.id, except: [...closed] }
                );
            }
            // Marqué quoi qu'il advienne de l'envoi : réessayer à chaque tour un
            // canal mal réglé produirait une boucle silencieuse.
            await this.deps.repo.markDeploymentNotified(item.row.id);
        }
    }

    /**
     * Publie ou modifie le message d'un déploiement sur chaque canal vivant, et
     * rend ceux qui l'ont accepté : c'est ce qui décide, canal par canal, qui
     * doit encore recevoir l'avis en texte. Le journal, le lieu et le dépôt sont
     * lus une fois pour tous les canaux.
     */
    private async renderNotice(input: {
        target: OpenTarget;
        history: DeploymentRow[];
        item: SeenDeployment;
        channels: readonly SdkLiveChannel[];
        notify: DevEyeFacade['notify'];
        cipher: SdkCipher;
        final: boolean;
        now: number;
    }): Promise<Set<number>> {
        const { item, cipher, notify } = input;
        const blob = (await readJson<Record<string, unknown>>(cipher, item.row.content)) ?? {};
        const noticeIds: Record<string, string> =
            blob.noticeIds && typeof blob.noticeIds === 'object'
                ? { ...(blob.noticeIds as Record<string, string>) }
                : {};

        const { notices, access, spec, name } = input.target;
        const [log, place, repoUrl] = await Promise.all([
            notices.noticeLog(access, spec, item.entry, { timeoutMs: DEPLOY_LOG_TIMEOUT_MS }).catch(() => ''),
            notices
                .place(access, spec, item.entry, name)
                .catch((): TargetPlace => ({ fields: [{ name: '⚙️ Cible', value: name }], link: null })),
            notices.repoUrl(access, spec).catch(() => null)
        ]);

        const message = buildNotice({
            fields: place.fields,
            link: place.link,
            repoUrl,
            title: item.entry.title,
            status: item.entry.status,
            startedAt: item.entry.startedAt,
            finishedAt: item.entry.finishedAt,
            error: item.entry.description,
            log,
            estimateSeconds: estimateFromHistory(input.history, item.row.id),
            now: input.now
        });

        const accepted = new Set<number>();
        let dirty = false;

        // Séquentiel, et non `Promise.all` : les canaux partagent le blob
        // `noticeIds` réécrit ci-dessous.
        for (const channel of input.channels) {
            const known = noticeIds[String(channel.id)] ?? null;

            // Un identifiant connu fait modifier le message, son absence en
            // publie un ; `null` si le canal a refusé (message supprimé à la
            // main, webhook révoqué).
            const posted = await notify.postLive(channel.id, message, known);
            if (posted === null) continue;
            accepted.add(channel.id);
            if (known !== null) continue;

            // Un déploiement conclu découvert après coup reçoit le même message,
            // publié une seule fois : rien à retenir pour un tour suivant.
            if (input.final) continue;

            // Retenu tout de suite : le tour suivant doit modifier ce message,
            // et non en poser un second à côté.
            noticeIds[String(channel.id)] = posted;
            dirty = true;
        }

        if (dirty) {
            // Relu juste avant d'écrire : pendant la publication, un autre
            // écrivain (le verdict d'une machine) a pu enrichir le blob.
            const fresh = await this.deps.repo.findDeployment(item.row.id);
            const current = (fresh ? await readJson<Record<string, unknown>>(cipher, fresh.content) : null) ?? blob;
            await this.deps.repo.setDeploymentContent(
                item.row.id,
                await cipher.encrypt(JSON.stringify({ ...current, noticeIds }))
            );
        }
        return accepted;
    }

    private async runAgentDeploy(job: AgentJob): Promise<void> {
        const { target, deploymentId, service } = job;
        const cipher = this.deps.cipherFor(target.workspace_id);
        const name = (await readJson<Partial<StoredTarget>>(cipher, target.content))?.name ?? target.external_id;
        const run: AgentRun = { job, name, lines: [], chars: 0, noticing: Promise.resolve(), queued: false };
        this.agentRuns.set(deploymentId, run);

        await this.setAgentStatus(job, { status: 'running', finishedAt: null });
        void this.refreshAgentNotice(run);

        const result = target.device_id
            ? await this.deps.agents.dockerRun(
                  target.device_id,
                  { engine: service.engine, action: 'composeDeploy', target: composeTargetOf(service) },
                  { onLine: (line) => keepLine(run, line) }
              )
            : { ok: false, error: 'Cette cible ne désigne plus de machine.' };

        // Le message en cours d'écriture d'abord : il range ses identifiants
        // dans le blob que le verdict va compléter.
        await run.noticing;
        await this.setAgentStatus(job, {
            status: result.ok ? 'success' : 'failed',
            finishedAt: Math.floor(Date.now() / 1000),
            error: result.ok ? undefined : (result.error ?? 'Le déploiement a échoué sur la machine.'),
            log: run.lines.join('\n')
        });
        await this.refreshAgentNotice(run);
    }

    /** L'état d'un déploiement par une machine ; l'erreur s'ajoute à la description saisie, le journal la suit. */
    private async setAgentStatus(
        job: AgentJob,
        next: { status: DeployStatus; finishedAt: number | null; error?: string; log?: string }
    ): Promise<void> {
        const cipher = this.deps.cipherFor(job.target.workspace_id);
        const row = await this.deps.repo.findDeployment(job.deploymentId);
        if (!row) return;
        const body = (await readJson<Partial<StoredDeployment>>(cipher, row.content)) ?? {};
        const description = next.error ? [body.description, next.error].filter(Boolean).join('\n') : body.description;
        await this.deps.repo.updateDeployment(row.id, {
            externalId: row.external_id,
            status: next.status,
            finishedAt: next.finishedAt,
            content: await cipher.encrypt(
                JSON.stringify({ ...body, description, ...(next.log !== undefined ? { log: next.log } : {}) })
            )
        });
        this.deps.live.changed(job.target.workspace_id);
    }

    private refreshAgentNotice(run: AgentRun): Promise<void> {
        if (run.queued) return run.noticing;
        run.queued = true;
        run.noticing = run.noticing
            .then(async () => {
                run.queued = false;
                await this.agentNotice(run);
            })
            .catch((e: unknown) =>
                this.deps.logger.warn({ err: e, deploymentId: run.job.deploymentId }, 'Deploy agent: avis en échec')
            );
        return run.noticing;
    }

    /**
     * Le message vivant d'un déploiement par une machine, sur le même chemin que
     * celui d'un fournisseur sondé : ouvert en vol, modifié à chaque battement,
     * conclu à l'atterrissage avec l'avis en texte.
     */
    private async agentNotice(run: AgentRun): Promise<void> {
        const { target, deploymentId, service } = run.job;
        const row = await this.deps.repo.findDeployment(deploymentId);
        if (!row) return;
        const cipher = this.deps.cipherFor(target.workspace_id);
        const body = await readJson<Partial<StoredDeployment>>(cipher, row.content);
        const status: DeployStatus =
            row.status === 'success' || row.status === 'failed' || row.status === 'running' ? row.status : 'queued';
        const entry: RemoteDeployment = {
            externalId: row.external_id,
            status,
            title: body?.title ?? 'Déploiement',
            description: status === 'failed' ? (body?.description ?? '') : '',
            startedAt: Number(row.started_at),
            finishedAt: row.finished_at === null ? null : Number(row.finished_at),
            logRef: null,
            url: null,
            details: []
        };
        const machine =
            (await this.deps.devicesFor(target.workspace_id).list()).find((d) => d.id === target.device_id)?.name ??
            'une machine';
        const open: OpenTarget = {
            row: { ...target, base_url: null, in_flight: 1 },
            notices: {
                noticeLog: async () => run.lines.join('\n'),
                place: async () => ({
                    fields: [
                        { name: '🖥️ Machine', value: machine },
                        { name: '🛠️ Projet', value: service.project },
                        { name: '⚙️ Service', value: service.service },
                        { name: '📦 Type', value: 'service compose' }
                    ],
                    link: null
                }),
                repoUrl: async () => null
            },
            access: { credentialId: 0, baseUrl: null, secret: '' },
            spec: { kind: 'service', externalId: target.external_id, ref: null },
            name: run.name
        };
        const history = await this.deps.repo.listDeployments(target.id, target.workspace_id, DEPLOY_IMPORT_LIMIT * 3);
        await this.updateDeployNotices({
            target: open,
            history,
            seen: [{ row, entry }],
            firstImport: false,
            now: Math.floor(Date.now() / 1000)
        });
    }

    /**
     * Le corps de l'avis en texte (mail, Slack, point d'entrée maison), construit
     * en un seul endroit quel que soit l'état du suivi vivant.
     */
    private deployAlert(targetName: string, item: LandedDeployment): SdkAlert {
        const failed = item.status === 'failed';
        // Même coupe que dans l'avis Discord : Dokploy range le message de commit
        // entier dans le titre, et un saut de ligne n'a rien à faire dans un
        // objet de mail.
        const label = firstLine(item.title) || 'Déploiement';
        const lines = [
            failed
                ? `Le déploiement « ${label} » de ${targetName} a échoué.`
                : `Le déploiement « ${label} » de ${targetName} est passé.`,
            '',
            `Cible : ${targetName}`,
            `État : ${failed ? 'Échec' : 'Succès'}`,
            `Démarré le : ${formatMoment(item.startedAt)}`
        ];
        if (item.finishedAt !== null) {
            lines.push(`Terminé le : ${formatMoment(item.finishedAt)}`);
            lines.push(`Durée : ${formatDuration(Math.max(0, item.finishedAt - item.startedAt))}`);
        }
        // La description porte le message d'erreur du fournisseur (voir
        // `readDeployments`) : la seule ligne qui dise pourquoi.
        if (item.description) lines.push('', item.description);

        return {
            subject: `[DevEye] ${failed ? 'Échec' : 'Succès'} du déploiement : ${targetName}`,
            body: lines.join('\n'),
            payload: {
                event: failed ? 'deploy_failed' : 'deploy_succeeded',
                target: targetName,
                title: label,
                at: item.finishedAt ?? item.startedAt
            }
        };
    }
}

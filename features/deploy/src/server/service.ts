import type { DeploymentRow, DeployTargetSyncRow } from '../contracts/domain';
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
import { formatDuration, formatMoment } from '@/Services/notifications';

import {
    dashboardUrl,
    fetchDeploymentLog,
    fetchRepoUrl,
    listDeployments,
    listTargets,
    type DokployDeployment,
    type DokployTarget
} from './dokploy';
import { buildNotice, estimateFromHistory, firstLine } from './notice';
import type { DeployRepo } from './repo';
import { readJson } from './_shared';

/**
 * Le rapprochement des cibles de déploiement avec ce que le fournisseur en dit,
 * en tâche de fond : un ticker du SDK, une garde de ré-entrance, des chiffres
 * par espace (`deps.cipherFor`). Il rapproche les cibles, pas seulement les
 * lignes déjà en base : un déploiement lancé depuis Dokploy, une CI ou un push
 * apparaît aussi. Voir {@link DeploySync.syncDeployTargets}.
 *
 * Tout est lu et écrit à l'étage ouvert : une cible appartient à l'espace et
 * ce service tourne sans session.
 */

/**
 * Cibles rapprochées par tour (une cible = un appel tRPC) : un espace à quarante
 * cibles ne produit pas quarante requêtes d'un coup, le reste passe au tour suivant.
 */
const DEPLOY_BATCH = 6;

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
 * Durée de vie du catalogue d'une instance (`project.all`, un appel pour toute
 * l'instance) : des noms d'organisation, qui ne bougent pas, et les redemander
 * à chaque battement coûterait un appel permanent.
 */
const DEPLOY_PLACE_TTL_SECONDS = 300;

/**
 * Lignes d'historique retenues par cible et par tour : Dokploy rend l'historique
 * complet, et au-delà de la tête ce sont des déploiements anciens, déjà en base.
 */
const DEPLOY_IMPORT_LIMIT = 20;

/**
 * Durée de vie du dépôt d'une cible. Un appel par cible, contrairement au
 * catalogue : plus long, parce qu'un dépôt bouge encore moins qu'un nom de
 * projet, et qu'une heure borne l'écart après un changement de source.
 */
const DEPLOY_REPO_TTL_SECONDS = 3600;

/**
 * Écart toléré pour rattacher un déploiement local à une ligne du fournisseur
 * quand l'identifiant externe manque : Dokploy n'en rend pas toujours un au
 * déclenchement, et c'est la date qui rapproche jusqu'à ce qu'il arrive.
 */
const DEPLOY_MATCH_WINDOW_SECONDS = 120;

/**
 * Âge au-delà duquel un déploiement local que le fournisseur ne reconnaît pas
 * cesse d'être en vol : sinon une ligne dont Dokploy n'a jamais rendu la trace
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
 * pas encore (`deploy.trigger` écrit avant d'appeler Dokploy). `claimed`
 * interdit qu'une ligne serve deux fois dans le tour.
 */
function matchDeployment(entry: DokployDeployment, local: DeploymentRow[], claimed: Set<number>): DeploymentRow | null {
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

/**
 * L'adaptateur Dokploy, injectable : un test simule une instance sans réseau.
 * Rien d'autre n'est simulable, le reste du chemin doit tourner tel quel.
 */
export interface DokployClient {
    listDeployments: typeof listDeployments;
    listTargets: typeof listTargets;
    fetchDeploymentLog: typeof fetchDeploymentLog;
    fetchRepoUrl: typeof fetchRepoUrl;
}

/** Ce qu'un tour a résolu : la ligne locale, et ce que le fournisseur en dit. */
interface SeenDeployment {
    row: DeploymentRow;
    entry: DokployDeployment;
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
     * Garde de ré-entrance, en plus de celle du ticker : `wake()` déclenche un
     * tour hors cadence, et deux tours concurrents publieraient deux messages
     * pour le même déploiement.
     */
    private ticking = false;

    /**
     * Cibles en recul, jusqu'à l'instant indiqué. En mémoire : c'est l'état d'une
     * instance injoignable depuis ce processus, et écrire dans `synced_at` un
     * rapprochement qui n'a pas eu lieu ferait passer le premier import pour
     * fait.
     */
    private readonly deployBackoff = new Map<number, number>();

    /** Le catalogue d'une instance, par jeton. Voir {@link DEPLOY_PLACE_TTL_SECONDS}. */
    private readonly deployPlaces = new Map<number, { at: number; targets: DokployTarget[] }>();

    /**
     * Le dépôt d'une cible, par jeton et identifiant externe. Seule l'adresse
     * est retenue : la fiche qui la porte contient aussi les identifiants du
     * fournisseur Git.
     */
    private readonly deployRepos = new Map<string, { at: number; url: string | null }>();

    constructor(
        private readonly deps: FeatureServiceDeps<DeployRepo>,
        private readonly dokploy: DokployClient = { listDeployments, listTargets, fetchDeploymentLog, fetchRepoUrl }
    ) {
        this.ticker = deps.createTicker({ intervalMs: DEPLOY_TICK_SECONDS * 1000, tick: () => this.tick() });
    }

    start(): void {
        this.ticker.start();
        this.deps.logger.info({ tickSeconds: DEPLOY_TICK_SECONDS }, 'Deploy sync started');
    }

    stop(): void {
        this.ticker.stop();
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
     * Un tour : rapprocher les cibles, entretenir les messages. Un tour qui
     * dépasse son intervalle saute un battement plutôt que de se chevaucher.
     */
    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            await this.syncDeployTargets();
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Deploy sync: tick failed');
        } finally {
            this.ticking = false;
        }
    }

    /**
     * Rapproche les cibles de ce que le fournisseur en dit. Dokploy n'émet
     * aucun webhook générique : c'est du sondage, borné par {@link DEPLOY_BATCH}
     * cibles par tour, {@link DEPLOY_MIN_INTERVAL_SECONDS} entre deux tours
     * d'une cible au repos, {@link DEPLOY_IMPORT_LIMIT} lignes par appel.
     */
    private async syncDeployTargets(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        // On demande large, on filtre en mémoire, on tranche : sans cela, une
        // poignée de cibles injoignables (en tête, n'ayant jamais abouti)
        // consommerait chaque tour.
        const due = await this.deps.repo.listTargetsDue(DEPLOY_BATCH * 4, now - DEPLOY_MIN_INTERVAL_SECONDS);
        const picked = due.filter((t) => (this.deployBackoff.get(t.id) ?? 0) <= now).slice(0, DEPLOY_BATCH);

        for (const target of picked) {
            try {
                await this.syncDeployTarget(target, now);
                this.deployBackoff.delete(target.id);
            } catch (e) {
                // Un recul en mémoire plutôt qu'en base : c'est l'instance qui ne
                // répond pas, pas la cible qui a changé. `synced_at` reste à sa
                // valeur, sinon un premier import raté passerait pour fait.
                this.deployBackoff.set(target.id, now + DEPLOY_MIN_INTERVAL_SECONDS);
                this.deps.logger.warn(
                    { err: e instanceof Error ? e.message : String(e), targetId: target.id },
                    'Deploy sync: cible non rapprochée'
                );
            }
        }
    }

    /**
     * Une cible : lire chez le fournisseur, réconcilier, prévenir de ce qui a
     * atterri. On écrit AVANT de notifier : un avis parti sur un état non
     * enregistré repartirait au tour suivant.
     */
    private async syncDeployTarget(target: DeployTargetSyncRow, now: number): Promise<void> {
        if (target.credential_id === null || !target.base_url) return;

        const cipher = this.deps.cipherFor(target.workspace_id);
        const credential = await this.deps.repo.findCredential(target.credential_id, target.workspace_id);
        if (!credential?.base_url) return;
        const apiKey = await cipher.decrypt(credential.secret_enc);

        const remote = await this.dokploy.listDeployments(
            credential.base_url,
            apiKey,
            target.target_kind === 'compose' ? 'compose' : 'application',
            target.external_id
        );

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
                    await this.deps.repo.updateDeployment(match.id, {
                        externalId,
                        status: entry.status,
                        finishedAt,
                        content: await cipher.encrypt(JSON.stringify({ ...body, description: entry.description }))
                    });
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
                        url: credential.base_url
                    })
                )
            });
            changed = true;
            seen.push({ row, entry });
        }

        // Ce que DevEye croit en vol et que le fournisseur ne connaît pas : passé
        // la borne, c'est un suivi perdu. Marqué `failed` faute d'état inconnu,
        // mais sans avis : annoncer un échec qu'on n'a pas constaté serait pire.
        for (const row of local) {
            if (claimed.has(row.id) || isTerminal(row.status)) continue;
            if (Number(row.started_at) > now - DEPLOY_STALE_SECONDS) continue;

            const body = await readJson<Record<string, unknown>>(cipher, row.content);
            await this.deps.repo.updateDeployment(row.id, {
                externalId: row.external_id,
                status: 'failed',
                finishedAt: now,
                content: await cipher.encrypt(
                    JSON.stringify({
                        ...body,
                        description: 'Suivi perdu : le fournisseur ne connaît plus ce déploiement.'
                    })
                )
            });
            await this.deps.repo.markDeploymentNotified(row.id);
            changed = true;
        }

        await this.deps.repo.markTargetSynced(target.id, now);

        if (changed) {
            // La fiche de la cible et l'onglet du projet suivent `deploy.detail`.
            // Les compteurs d'onglets d'un projet (sujet `projects`, qu'un module
            // ne nomme pas) se relisent à leur prochaine ouverture.
            this.deps.live.changed(target.workspace_id);
        }

        await this.updateDeployNotices({
            target,
            baseUrl: credential.base_url,
            apiKey,
            history: local,
            seen,
            firstImport,
            now
        });
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
        target: DeployTargetSyncRow;
        baseUrl: string;
        apiKey: string;
        history: DeploymentRow[];
        seen: SeenDeployment[];
        firstImport: boolean;
        now: number;
    }): Promise<void> {
        const { target, seen, firstImport } = input;
        const place = {
            credentialId: target.credential_id ?? 0,
            externalId: target.external_id,
            kind: (target.target_kind === 'compose' ? 'compose' : 'application') as 'application' | 'compose'
        };
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
        const name = (await readJson<{ name?: string }>(cipher, target.content))?.name ?? target.external_id;

        // Les journaux en parallèle par déploiement (chaque lecture va au bout
        // de son délai), jamais par canal d'un même déploiement : ceux-là
        // écrivent tous dans le même blob `noticeIds`.
        if (live.length > 0) {
            await Promise.all(
                inFlight.map((item) =>
                    this.renderNotice({
                        ...input,
                        ...place,
                        item,
                        name,
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
                              ...place,
                              item,
                              name,
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
     * doit encore recevoir l'avis en texte. Le journal et l'emplacement sont
     * lus une fois pour tous les canaux : deux appels réseau.
     */
    private async renderNotice(input: {
        baseUrl: string;
        apiKey: string;
        credentialId: number;
        externalId: string;
        kind: 'application' | 'compose';
        history: DeploymentRow[];
        item: SeenDeployment;
        name: string;
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

        const [log, place, repoUrl] = await Promise.all([
            item.entry.logPath
                ? this.dokploy
                      .fetchDeploymentLog(input.baseUrl, input.apiKey, item.entry.logPath, {
                          timeoutMs: DEPLOY_LOG_TIMEOUT_MS
                      })
                      .catch(() => '')
                : Promise.resolve(''),
            this.deployPlace(input.credentialId, input.baseUrl, input.apiKey, input.externalId),
            this.deployRepo(input.credentialId, input.baseUrl, input.apiKey, input.kind, input.externalId)
        ]);

        const message = buildNotice({
            // Le nom donné à la cible dans DevEye sert de repli : une instance
            // injoignable fait perdre les trois colonnes, jamais l'identité.
            project: place?.projectName ?? null,
            service: place?.name ?? input.name,
            environment: place?.environmentName ?? null,
            kind: input.kind,
            url: place ? dashboardUrl(input.baseUrl, place) : null,
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
            await this.deps.repo.setDeploymentContent(
                item.row.id,
                await cipher.encrypt(JSON.stringify({ ...blob, noticeIds }))
            );
        }
        return accepted;
    }

    /**
     * Où vit une cible chez le fournisseur : projet, environnement, et de quoi
     * bâtir le lien vers sa fiche. Un seul `project.all` mémoïsé pour toute
     * l'instance ({@link DEPLOY_PLACE_TTL_SECONDS}) ; `null` si l'instance ne
     * répond pas ou ne connaît plus la cible.
     */
    private async deployPlace(
        credentialId: number,
        baseUrl: string,
        apiKey: string,
        externalId: string
    ): Promise<DokployTarget | null> {
        const now = Math.floor(Date.now() / 1000);
        let cached = this.deployPlaces.get(credentialId);
        if (!cached || now - cached.at > DEPLOY_PLACE_TTL_SECONDS) {
            try {
                cached = { at: now, targets: await this.dokploy.listTargets(baseUrl, apiKey) };
                this.deployPlaces.set(credentialId, cached);
            } catch {
                // Le catalogue périmé vaut mieux que rien : les noms de projet
                // ne bougent pas.
                if (!cached) return null;
            }
        }
        return cached.targets.find((t) => t.externalId === externalId) ?? null;
    }

    /**
     * Le dépôt d'une cible, mémoïsé {@link DEPLOY_REPO_TTL_SECONDS}. Le résultat
     * vide compte comme une réponse : une cible sur une image Docker n'a pas de
     * dépôt, et redemander à chaque battement coûterait un appel toutes les dix
     * secondes pour rien. Une instance qui ne répond pas ne laisse rien en
     * cache : c'est le message qui perd son lien, pas la cible.
     */
    private async deployRepo(
        credentialId: number,
        baseUrl: string,
        apiKey: string,
        kind: 'application' | 'compose',
        externalId: string
    ): Promise<string | null> {
        const key = `${credentialId}:${externalId}`;
        const now = Math.floor(Date.now() / 1000);
        const cached = this.deployRepos.get(key);
        if (cached && now - cached.at <= DEPLOY_REPO_TTL_SECONDS) return cached.url;

        try {
            const url = await this.dokploy.fetchRepoUrl(baseUrl, apiKey, kind, externalId);
            this.deployRepos.set(key, { at: now, url });
            return url;
        } catch {
            return cached?.url ?? null;
        }
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
            subject: `[DevEye] ${failed ? 'Échec' : 'Succès'} du déploiement — ${targetName}`,
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

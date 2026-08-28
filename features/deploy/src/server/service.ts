import type { DeploymentRow, DeployTargetSyncRow } from '../contracts/domain';
import type {
    DevEyeFacade,
    FeatureService,
    FeatureServiceDeps,
    SdkAlert,
    SdkCipher,
    SdkLiveChannel
} from '@deveye/types/sdk/server';

// Privilège de native rapatriée, commenté à chaque usage : l'horodatage et la
// durée des corps d'alerte sont ceux de `Services/notifications`, partagés par
// les émetteurs de l'app (un avis de déploiement horodaté autrement qu'une
// alerte de disponibilité donnerait l'impression de venir d'un autre produit).
import { formatDuration, formatMoment } from '@/Services/notifications';

import {
    dashboardUrl,
    fetchDeploymentLog,
    listDeployments,
    listTargets,
    type DokployDeployment,
    type DokployTarget
} from './dokploy';
import { buildNotice, estimateFromHistory, firstLine } from './notice';
import type { DeployRepo } from './repo';
import { readJson } from './_shared';

/**
 * Le rapprochement des **cibles de déploiement** avec ce que le fournisseur en
 * dit, en tâche de fond.
 *
 * C'était la moitié déploiement de l'`IntegrationSyncService` de l'app, qui
 * l'hébergeait à côté de la synchronisation des dépôts git parce que les deux
 * ont exactement la même forme — un minuteur, un budget d'appels, un
 * fournisseur tiers qui répond quand il veut — et non parce qu'ils parlent de
 * la même chose. Le rapatriement en module a rendu chacun à sa feature ; la
 * structure reste celle de `UptimeMonitor` : un ticker du SDK, une garde de
 * ré-entrance, et des chiffres mémoïsés par espace (`deps.cipherFor`).
 *
 * Le volet a changé de sujet en cours de route : il suivait les **lignes**
 * encore en vol, il rapproche désormais les **cibles**. La nuance décide de ce
 * qui est visible — seules les lignes écrites par `deploy.trigger` existaient
 * en base, donc un déploiement lancé depuis Dokploy, une CI ou un push git
 * n'apparaissait nulle part tant qu'on n'ouvrait pas sa fiche, qui interroge
 * l'instance en direct. Voir {@link DeploySync.syncDeployTargets}.
 *
 * **Tout est lu et écrit à l'étage ouvert.** Une cible appartient à l'espace
 * (migration 080) : elle n'a pas de palier de confidentialité à suivre, et ce
 * service — qui tourne sans session — peut donc toujours la lire.
 */

/**
 * Cibles de déploiement rapprochées par tour.
 *
 * Une cible = un appel tRPC. La borne existe pour qu'un espace à quarante cibles
 * ne produise pas quarante requêtes sortantes d'un coup ; celles qui n'ont pas
 * eu leur tour passeront au suivant, dix secondes plus tard.
 */
const DEPLOY_BATCH = 6;

/**
 * Délai minimal entre deux rapprochements d'une même cible **au repos**.
 *
 * Une cible qui a un déploiement en vol échappe à ce délai et passe à chaque
 * tour : c'est là que l'état bouge à la minute. Les autres n'ont rien à dire
 * plus souvent qu'un quart d'heure — un déploiement lancé ailleurs y apparaîtra
 * au plus tard à ce délai, et sa fiche, elle, interroge l'instance en direct.
 */
const DEPLOY_MIN_INTERVAL_SECONDS = 60;

/**
 * Cadence propre au volet déploiement.
 *
 * Il tournait dans le tour de la synchronisation git, à 120 s — ce qui plafonnait
 * tout : un intervalle au repos plus court que le tour n'aurait rien changé, et
 * un message de suivi ne peut pas se rafraîchir moins souvent que la boucle qui
 * l'alimente. D'où un minuteur à lui, dix fois plus rapide, pendant que les
 * dépôts gardent le leur : les deux n'ont jamais eu la même urgence, ils
 * partageaient un tour par accident d'implémentation.
 *
 * Dix secondes, c'est aussi la cadence de modification du message Discord.
 * Discord tolère environ cinq requêtes par deux secondes et par webhook ; on en
 * fait une par déploiement en vol, ce qui laisse une marge considérable.
 */
const DEPLOY_TICK_SECONDS = 10;

/**
 * Délai de lecture de la queue du journal, pendant un déploiement.
 *
 * Court, et il le faut : le flux d'un déploiement **en cours** ne se referme
 * pas de lui-même, donc chaque lecture va au bout de son délai. Trente secondes
 * — le régime de la lecture à la demande — feraient durer un tour plus longtemps
 * que l'intervalle qui le déclenche.
 */
const DEPLOY_LOG_TIMEOUT_MS = 3_000;

/**
 * Durée de vie du catalogue d'une instance, en mémoire.
 *
 * Un avis nomme le projet, le service et l'environnement séparément, comme
 * Dokploy le fait dans les siens — or DevEye ne retient d'une cible que son
 * identifiant externe et le nom qu'on lui a donné. Le reste vient de
 * `project.all`, un seul appel pour **toute** l'instance.
 *
 * Mémoïsé cinq minutes : ce sont des noms d'organisation, qui bougent une fois
 * par trimestre, et les redemander à chaque battement de dix secondes coûterait
 * un appel permanent pour une donnée immobile.
 */
const DEPLOY_PLACE_TTL_SECONDS = 300;

/**
 * Lignes d'historique retenues par cible et par tour.
 *
 * Dokploy rend l'historique complet d'une application, qui peut compter des
 * centaines d'entrées. On n'en garde que la tête : au-delà, ce sont des
 * déploiements anciens, déjà en base s'ils comptaient, et les recopier à chaque
 * tour ne ferait qu'alourdir la table.
 */
const DEPLOY_IMPORT_LIMIT = 20;

/**
 * Écart toléré pour rattacher un déploiement local à une ligne du fournisseur
 * **quand l'identifiant externe manque**.
 *
 * Dokploy ne rend pas toujours d'identifiant au déclenchement : la ligne écrite
 * par `deploy.trigger` naît donc sans `external_id`, et c'est la date qui les
 * rapproche jusqu'à ce qu'il arrive. Deux minutes, parce que c'est le délai
 * entre l'écriture locale et la prise en compte côté fournisseur, pas la durée
 * d'un déploiement.
 */
const DEPLOY_MATCH_WINDOW_SECONDS = 120;

/**
 * Âge au-delà duquel un déploiement local **que le fournisseur ne reconnaît
 * pas** cesse d'être considéré en vol.
 *
 * Sans cette borne, une ligne écrite par `deploy.trigger` dont Dokploy n'a
 * jamais rendu la trace — l'ordre perdu, l'instance redéployée entre-temps —
 * reste `queued` indéfiniment. Elle mentirait doublement : à l'écran, en
 * affichant un déploiement qui n'avance pas, et dans l'ordonnanceur, en gardant
 * sa cible dans la voie rapide à chaque tour, pour toujours.
 *
 * Six heures, soit bien au-delà de ce que dure une mise en production, pour ne
 * jamais couper un déploiement réellement long.
 */
const DEPLOY_STALE_SECONDS = 6 * 3600;

/** Un déploiement dont l'issue est connue : c'est ce qui mérite un avis. */
function isTerminal(status: string): boolean {
    return status === 'success' || status === 'failed';
}

/**
 * Retrouve la ligne locale que décrit une entrée du fournisseur.
 *
 * Deux clés, dans cet ordre, et c'est l'ordre qui compte. L'identifiant externe
 * est le seul rapprochement sûr ; la date ne sert qu'aux lignes qui n'en ont
 * **pas encore** — `deploy.trigger` écrit sa ligne avant d'appeler Dokploy, qui
 * ne rend pas toujours d'identifiant au déclenchement. Réserver la date aux
 * lignes sans identifiant évite de recoller deux déploiements distincts du
 * fournisseur sur la même ligne locale quand ils sont partis à quelques secondes
 * d'intervalle.
 *
 * `claimed` interdit qu'une même ligne serve deux fois dans le tour : sans lui,
 * deux entrées voisines choisiraient la même et l'une des deux serait perdue.
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
 * La couture de test du service : l'adaptateur Dokploy, injectable.
 *
 * Les vraies fonctions de `dokploy.ts` par défaut ; un test en simule une
 * instance, sans réseau, et décide de ce qu'elle répond (historique, catalogue,
 * journal). Rien d'autre n'est simulable ici, et c'est voulu : le reste du
 * chemin (rapprochement, écritures, messages vivants, avis) est précisément ce
 * qu'on veut voir tourner tel quel.
 */
export interface DokployClient {
    listDeployments: typeof listDeployments;
    listTargets: typeof listTargets;
    fetchDeploymentLog: typeof fetchDeploymentLog;
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
     * pour le même déploiement, chacun ignorant l'identifiant que l'autre
     * vient d'écrire.
     */
    private ticking = false;

    /**
     * Cibles de déploiement en recul, jusqu'à l'instant indiqué.
     *
     * En mémoire et non en base : c'est l'état d'une instance Dokploy
     * injoignable *depuis ce processus*, pas un fait sur la cible. Le garder
     * ici évite surtout d'écrire dans `synced_at` un rapprochement qui n'a pas
     * eu lieu — ce qui ferait passer le premier import pour fait, et
     * transformerait tout l'historique de la cible en avis au tour suivant.
     */
    private readonly deployBackoff = new Map<number, number>();

    /** Le catalogue d'une instance, par jeton. Voir {@link DEPLOY_PLACE_TTL_SECONDS}. */
    private readonly deployPlaces = new Map<number, { at: number; targets: DokployTarget[] }>();

    constructor(
        private readonly deps: FeatureServiceDeps<DeployRepo>,
        private readonly dokploy: DokployClient = { listDeployments, listTargets, fetchDeploymentLog }
    ) {
        // Son propre minuteur : voir {@link DEPLOY_TICK_SECONDS}. Un déploiement
        // se suit à la dizaine de secondes, un dépôt git à la dizaine de minutes.
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
     * Déclenche un tour tout de suite, sans viser de cible.
     *
     * Sert au déclenchement d'un déploiement : il n'y a rien à synchroniser côté
     * git, seulement un suivi d'état à reprendre plus tôt que la cadence. La
     * garde de ré-entrance de `tick()` rend l'appel inoffensif s'il en tourne
     * déjà un.
     *
     * C'est aussi ce qui ouvre le message de suivi dans la seconde qui suit un
     * déclenchement parti d'ici, sans attendre le prochain battement.
     */
    wake(): void {
        void this.tick();
    }

    /**
     * Le tour du déploiement : rapprocher les cibles, entretenir les messages.
     *
     * Un tour qui lit la queue du journal de plusieurs déploiements en vol peut
     * dépasser son intervalle ; il saute alors un battement plutôt que de se
     * chevaucher.
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
     * Rapproche les cibles de déploiement de ce que le fournisseur en dit.
     *
     * **Par cible, et non plus par ligne locale.** L'ancienne passe ne
     * réinterrogeait que les déploiements déjà en base, c'est-à-dire ceux que
     * `deploy.trigger` avait écrits : tout ce qui partait de l'interface de
     * Dokploy, d'une CI ou d'un push git n'existait nulle part côté DevEye, et
     * n'apparaissait qu'en ouvrant une fiche — qui interroge l'instance en
     * direct. En arrivant sur la page, la liste ne montrait rien de tout cela.
     *
     * DevEye ne reçoit toujours aucun webhook : Dokploy n'en émet pas de forme
     * générique, ses « notifications » étant mises en page pour Discord, Slack
     * ou Telegram. C'est donc du sondage, mais borné de trois façons —
     * {@link DEPLOY_BATCH} cibles par tour, {@link DEPLOY_MIN_INTERVAL_SECONDS}
     * entre deux tours d'une même cible au repos, {@link DEPLOY_IMPORT_LIMIT}
     * lignes retenues par appel. Une cible qui a un déploiement en vol échappe
     * au deuxième et passe à chaque tour, là où l'état bouge vraiment.
     */
    private async syncDeployTargets(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        // Même forme que la sélection des dépôts : on demande large, on filtre
        // en mémoire, on tranche. Sans cela, une poignée de cibles injoignables
        // — qui trient en tête, n'ayant jamais abouti — consommerait chaque tour
        // et les autres ne passeraient jamais.
        const due = await this.deps.repo.listTargetsDue(DEPLOY_BATCH * 4, now - DEPLOY_MIN_INTERVAL_SECONDS);
        const picked = due.filter((t) => (this.deployBackoff.get(t.id) ?? 0) <= now).slice(0, DEPLOY_BATCH);

        for (const target of picked) {
            try {
                await this.syncDeployTarget(target, now);
                this.deployBackoff.delete(target.id);
            } catch (e) {
                // Un recul en mémoire plutôt qu'en base : c'est l'instance qui
                // ne répond pas, pas la cible qui a changé. `synced_at` reste
                // donc à sa valeur — et à `null` si le premier import n'a jamais
                // abouti, sans quoi le suivant prendrait tout l'historique pour
                // du neuf et enverrait un avis par ligne.
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
     * atterri.
     *
     * L'ordre compte. On écrit **avant** de notifier : un avis parti sur un état
     * qui n'a pas été enregistré repartirait au tour suivant, alors qu'un état
     * enregistré sans avis ne se perd que d'un message.
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

        // Le premier rapprochement **garnit sans prévenir** : tout l'historique
        // d'une cible est « nouveau » ce jour-là sans que rien ne vienne de se
        // produire, et l'annoncer serait un mensonge sur la date.
        const firstImport = target.synced_at === null;
        const local = await this.deps.repo.listDeployments(target.id, target.workspace_id, DEPLOY_IMPORT_LIMIT * 3);

        const recent = [...remote].sort((a, b) => b.startedAt - a.startedAt).slice(0, DEPLOY_IMPORT_LIMIT);
        /** Lignes locales déjà appariées : une ligne ne vaut que pour un distant. */
        const claimed = new Set<number>();
        /**
         * Ce que ce tour a résolu : la ligne locale, et ce que le fournisseur en
         * dit.
         *
         * Une seule liste pour les lignes appariées **et** créées, là où il n'y
         * avait qu'une liste des atterrissages. Le suivi vivant a besoin des
         * deux : un déploiement encore en cours n'atterrit pas, et c'est
         * justement lui qu'il faut montrer.
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

            // Inconnu ici : un déploiement parti d'ailleurs. Il entre avec la
            // date et l'état du fournisseur, sans auteur — l'ordre ne vient de
            // personne dans DevEye.
            const row = await this.deps.repo.createRemoteDeployment({
                targetId: target.id,
                workspaceId: target.workspace_id,
                externalId: entry.externalId,
                status: entry.status,
                startedAt: entry.startedAt,
                finishedAt: entry.finishedAt,
                // Le premier import tait le **passé**, pas le présent : une pile
                // en cours de déploiement à cet instant-là est un fait réel, qui
                // va atterrir dans quelques minutes et mérite son avis. Seul ce
                // qui est déjà terminé entre en base marqué comme annoncé.
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

        // Ce que DevEye croit en vol et que le fournisseur ne connaît pas : au
        // bout d'un moment, ce n'est plus un déploiement en cours, c'est un
        // suivi perdu. Marqué `failed` faute d'état « inconnu » dans le
        // vocabulaire — mais **sans avis**, et c'est délibéré : on ne sait
        // justement pas ce qui s'est passé, et annoncer un échec qu'on n'a pas
        // constaté serait pire que de ne rien dire. La ligne, elle, le dit.
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
            // Le sujet du module, et lui seul : la fiche de la cible **et**
            // l'onglet du projet qui la déploie suivent `deploy.detail`, donc
            // montrent le même état. (Le sujet `projects`, que le service
            // natif diffusait aussi, n'est pas nommable par un module : les
            // compteurs d'onglets d'un projet se remettent à jour à leur
            // prochaine lecture.)
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
     * ## Un seul message par déploiement, du début à la fin
     *
     * Discord est le seul canal qui sache modifier ce qu'il a déjà envoyé (voir
     * `Services/discord.ts`, derrière `notify.postLive`). Quand un canal routé
     * en est un, un déploiement découvert **en vol** ouvre un message, que les
     * tours suivants modifient — barre d'avancement, temps écoulé, queue du
     * journal — jusqu'à la conclusion, qui remplace le tout par l'issue, la
     * durée et l'erreur s'il y en a une. L'identifiant du message vit dans le
     * blob de la ligne, donc un serveur redémarré en cours de route reprend le
     * même message.
     *
     * **Un déploiement trop court pour être vu en vol reçoit le même message**,
     * publié une seule fois. Huit secondes suffisent à passer entre deux
     * battements, et la première version renvoyait ces cas-là vers l'avis en
     * texte brut : on obtenait une fiche complète pour un déploiement d'une
     * minute et trois lignes de texte pour celui d'à côté, sans que rien
     * n'explique la différence.
     *
     * ## Les autres canaux ne perdent rien
     *
     * Un webhook Slack ou maison, et le mail, reçoivent ce qu'ils recevaient : un
     * message unique à l'atterrissage. Le suivi vivant est une **couche en plus**
     * là où la plateforme le permet, jamais un remplacement — c'est ce qui permet
     * de ne rien demander de nouveau à la configuration.
     *
     * Corollaire à ne pas manquer : quand le suivi vivant a conclu, le canal
     * est retiré de la livraison finale (`except`). Sans cela, Discord recevrait
     * le message modifié **et** un second message en clair juste en dessous.
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
        // `now` n'est pas déstructuré : il n'est utile qu'au rendu du message,
        // qui le reçoit par le `...input` transmis à `renderNotice`.
        const { target, seen, firstImport } = input;
        // Ce que `renderNotice` doit savoir de la cible, assemblé une fois :
        // il en a besoin pour situer le service chez le fournisseur.
        const place = {
            credentialId: target.credential_id ?? 0,
            externalId: target.external_id,
            kind: (target.target_kind === 'compose' ? 'compose' : 'application') as 'application' | 'compose'
        };
        // Passé {@link DEPLOY_STALE_SECONDS}, on cesse d'entretenir le message :
        // un déploiement que le fournisseur laisse « en cours » pour toujours —
        // une file bloquée, un agent mort sans le dire — ferait sinon une
        // modification Discord toutes les dix secondes, indéfiniment. Le message
        // reste à son dernier état, qui annonce déjà « plus long que d'habitude ».
        const inFlight = seen.filter(
            (item) => !isTerminal(item.entry.status) && item.entry.startedAt > input.now - DEPLOY_STALE_SECONDS
        );
        // Le premier rapprochement ne conclut **jamais** — on ne peut pas
        // distinguer, ce jour-là, « vient d'atterrir » de « a atterri il y a
        // trois semaines ». Seule la marque part, pour que le tour suivant n'y
        // revienne pas.
        const landed = seen.filter((item) => isTerminal(item.entry.status) && item.row.notified === 0);
        if (inFlight.length === 0 && landed.length === 0) return;

        const cipher = this.deps.cipherFor(target.workspace_id);
        // La cible est passée : une route posée sur elle décide, de sorte que
        // deux applications puissent annoncer dans deux salons différents. Les
        // canaux vivants sont ceux de cette route qui savent modifier un
        // message (Discord), résolus par la façade.
        const notify = this.deps.deveyeFor(target.workspace_id).notify;
        const live = await notify.liveChannels({ itemId: target.id });
        const name = (await readJson<{ name?: string }>(cipher, target.content))?.name ?? target.external_id;

        // Les journaux en parallèle : chaque lecture va au bout de son délai,
        // le flux d'un déploiement en cours ne se refermant pas de lui-même.
        // Les enchaîner ferait dépasser l'intervalle dès deux déploiements.
        //
        // Le parallélisme porte sur les **déploiements**, jamais sur les canaux
        // d'un même déploiement : ceux-là écrivent tous dans le même blob
        // `noticeIds`, et les lancer de front en perdrait — le dernier écrivain
        // écraserait les identifiants publiés par les autres.
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
                // Un canal dont le message vivant a conclu a déjà tout dit :
                // lui renvoyer l'avis en texte afficherait deux fois la même
                // chose. Les autres — le mail, les webhooks génériques, et un
                // salon Discord dont le suivi n'a pas pu s'ouvrir — le reçoivent
                // par la façade, sur les canaux de la feature **Déploiement** :
                // ses propres canaux, jamais ceux d'Uptime (un déploiement raté
                // ne concerne ni les mêmes personnes ni le même salon qu'un
                // service tombé ; le travers corrigé pour Sentinelle en 075 et
                // pour Bases de données en 085). Toujours tenté : c'est la
                // route qui décide, et la façade ne fait rien sans canal.
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
            // Marqué quoi qu'il advienne de l'envoi : la façade avale déjà ses
            // erreurs, et réessayer à chaque tour un canal mal réglé produirait
            // une boucle silencieuse plutôt qu'un rattrapage.
            await this.deps.repo.markDeploymentNotified(item.row.id);
        }
    }

    /**
     * Publie ou modifie le message d'un déploiement, **sur chaque canal
     * vivant**, et rend l'ensemble de ceux qui l'ont accepté.
     *
     * L'ensemble rendu compte : c'est lui qui décide, canal par canal, qui a
     * déjà tout dit et qui doit encore recevoir l'avis en texte. Un salon dont
     * le message n'a pas pu s'ouvrir n'est pas privé de la nouvelle — c'était
     * déjà l'esprit du booléen qu'il remplace, appliqué maintenant à une liste.
     *
     * Le journal et l'emplacement sont lus **une fois** pour tous les canaux :
     * ce sont deux appels réseau vers l'instance, et les refaire par salon
     * multiplierait le coût d'un déploiement par le nombre de destinations sans
     * rien changer au message obtenu.
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

        const [log, place] = await Promise.all([
            item.entry.logPath
                ? this.dokploy
                      .fetchDeploymentLog(input.baseUrl, input.apiKey, item.entry.logPath, {
                          timeoutMs: DEPLOY_LOG_TIMEOUT_MS
                      })
                      .catch(() => '')
                : Promise.resolve(''),
            this.deployPlace(input.credentialId, input.baseUrl, input.apiKey, input.externalId)
        ]);

        const message = buildNotice({
            // Le nom donné à la cible dans DevEye sert de repli : une instance
            // injoignable ou d'une autre version fait perdre le découpage en
            // trois colonnes, jamais l'identité de ce qui a été déployé.
            project: place?.projectName ?? null,
            service: place?.name ?? input.name,
            environment: place?.environmentName ?? null,
            kind: input.kind,
            url: place ? dashboardUrl(input.baseUrl, place) : null,
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
        // `noticeIds` qu'on réécrit ci-dessous. Le nombre de salons se compte
        // sur les doigts d'une main, la latence ajoutée est sans commune mesure
        // avec la lecture de journal déjà faite.
        for (const channel of input.channels) {
            const known = noticeIds[String(channel.id)] ?? null;

            // Un identifiant connu fait modifier le message, son absence en
            // publie un ; la façade rend l'identifiant à garder, ou `null` si
            // le canal a refusé (message supprimé à la main, webhook révoqué).
            const posted = await notify.postLive(channel.id, message, known);
            if (posted === null) continue;
            accepted.add(channel.id);
            if (known !== null) continue;

            // Un déploiement conclu qu'on découvre après coup — le cas d'un
            // déploiement de huit secondes, commencé et fini entre deux
            // battements — reçoit le **même** message, publié une seule fois. Il
            // n'a jamais rien suivi, mais il n'y a aucune raison de le rendre
            // plus pauvre que les autres : c'était le défaut de la première
            // version, qui le renvoyait vers l'avis en texte brut.
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
     * bâtir le lien vers sa fiche.
     *
     * Un seul appel `project.all` sert **toute** l'instance, et il est mémoïsé
     * (voir {@link DEPLOY_PLACE_TTL_SECONDS}). `null` quand l'instance ne répond
     * pas ou ne connaît plus la cible : l'avis retombe alors sur le nom donné
     * dans DevEye, ce qui suffit à savoir de quoi on parle.
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
                // ne bougent pas, et priver l'avis de ses colonnes parce que
                // l'instance a hoqueté serait une perte pour rien.
                if (!cached) return null;
            }
        }
        return cached.targets.find((t) => t.externalId === externalId) ?? null;
    }

    /**
     * Le corps de l'avis, en texte — mail, Slack, point d'entrée maison.
     *
     * Séparé de son envoi parce qu'il sert quel que soit l'état du suivi
     * vivant : l'avis ordinaire, et le mail seul quand le suivi a déjà conclu
     * côté Discord. Le construire aux deux endroits aurait garanti que l'un des
     * deux finisse par oublier une ligne.
     */
    private deployAlert(targetName: string, item: LandedDeployment): SdkAlert {
        const failed = item.status === 'failed';
        // Même coupe que dans l'avis Discord, et pour la même raison : Dokploy
        // range le message de commit entier dans le titre. Un corps de commit au
        // milieu d'une phrase entre guillemets — ou, pire, dans un objet de mail,
        // où un saut de ligne n'a rien à faire — ne rend service à personne.
        const label = firstLine(item.title) || 'Déploiement';
        const lines = [
            failed
                ? `Le déploiement « ${label} » de ${targetName} a échoué.`
                : `Le déploiement « ${label} » de ${targetName} est passé.`,
            '',
            `Cible       : ${targetName}`,
            `État        : ${failed ? 'Échec' : 'Succès'}`,
            `Démarré le  : ${formatMoment(item.startedAt)}`
        ];
        if (item.finishedAt !== null) {
            lines.push(`Terminé le  : ${formatMoment(item.finishedAt)}`);
            lines.push(`Durée       : ${formatDuration(Math.max(0, item.finishedAt - item.startedAt))}`);
        }
        // La description porte le message d'erreur du fournisseur quand il y en
        // a un (voir `readDeployments`) : c'est la seule ligne qui dise
        // *pourquoi*, et la couper serait renvoyer l'utilisateur chez Dokploy.
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

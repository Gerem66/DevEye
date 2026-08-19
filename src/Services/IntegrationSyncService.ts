import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { LiveHub } from '@/live/hub';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import type { Logger } from 'pino';
import type { DeploymentRow, DeployTargetSyncRow, GitSyncStatus } from 'deveye-types';
import {
    authorRef,
    fetchBranches,
    fetchCommits,
    fetchComparison,
    fetchPullRequests,
    fetchReleases,
    fetchRepoInfo,
    GitHubError,
    nameRef,
    type GitHubCommit,
    type GitHubSyncState
} from './integrations/github';
import {
    dashboardUrl,
    fetchDeploymentLog,
    listDeployments,
    listTargets,
    type DokployDeployment,
    type DokployTarget
} from './integrations/dokploy';
import { buildNotice, estimateFromHistory } from '@/Services/DeployNotice';
import { editMessage, isDiscordWebhook, postMessage } from '@/Services/discord';
import {
    deliver,
    formatDuration,
    formatMoment,
    hasChannel,
    resolveChannels,
    type Alert
} from '@/Services/notifications';

/**
 * Les intégrations externes, en tâche de fond : synchronisation des **dépôts
 * git de l'espace**, et rapprochement des **cibles de déploiement** avec ce que
 * le fournisseur en dit.
 *
 * Les deux vivent dans le même service parce qu'ils ont exactement la même
 * forme — un minuteur, un budget d'appels, un fournisseur tiers qui répond
 * quand il veut — et non parce qu'ils parlent de la même chose. Structure
 * calquée sur {@link UptimeMonitor} : un minuteur `unref`é, une garde de
 * ré-entrance, une carte de promesses en vol pour ne jamais traiter deux fois
 * le même dépôt, et des chiffres mémoïsés par espace.
 *
 * Le volet déploiement a changé de sujet : il suivait les **lignes** encore en
 * vol, il rapproche désormais les **cibles**. La nuance décide de ce qui est
 * visible — seules les lignes écrites par `deploy.trigger` existaient en base,
 * donc un déploiement lancé depuis Dokploy, une CI ou un push git n'apparaissait
 * nulle part tant qu'on n'ouvrait pas sa fiche, qui interroge l'instance en
 * direct. Voir {@link IntegrationSyncService.syncDeployTargets}.
 *
 * **Tout est lu et écrit à l'étage ouvert.** Depuis la migration `064`, un dépôt
 * appartient à l'espace : il n'a plus de palier de confidentialité à suivre, et
 * ce service — qui tourne sans session — peut donc toujours le lire. C'est ce
 * qui a fait disparaître la garde atomique sur `security_tier` que portait
 * l'ancien `markSynced`, et avec elle toute une classe de courses.
 */

/** Cadence de l'ordonnanceur. */
const TICK_SECONDS = 120;

/** Dépôts traités par tour : borne la rafale d'appels au fournisseur. */
const BATCH = 3;

/** Délai minimal entre deux synchronisations d'un même dépôt. */
const MIN_INTERVAL_SECONDS = 600;

/** Recul appliqué quand le fournisseur annonce un quota épuisé. */
const RATE_LIMIT_BACKOFF_SECONDS = 3600;

/**
 * Pages de commits lues par tour, en régime établi.
 *
 * Cinq cents commits d'un coup couvrent très largement ce qui a pu arriver en
 * dix minutes ; au-delà, c'est du backfill, qui a son propre budget.
 */
const HEAD_PAGES = 5;

/**
 * Pages lues par tour pour rapatrier l'historique ancien.
 *
 * Trois mille commits par tranche : assez pour qu'un dépôt de vingt mille
 * commits soit complet en une poignée de tours, assez peu pour qu'un tour reste
 * court et que le quota (5 000 requêtes/heure) ne soit jamais en cause — trente
 * requêtes par tranche.
 */
const BACKFILL_PAGES = 30;

/**
 * Délai avant de reprendre un backfill inachevé.
 *
 * Court, et volontairement : tant que l'historique est incomplet, le graphe
 * ment sur l'âge du dépôt. On enchaîne donc les tranches au lieu d'attendre la
 * cadence ordinaire, jusqu'à toucher le premier commit — après quoi ce dépôt
 * repasse au régime commun.
 */
const BACKFILL_GAP_MS = 3_000;

/**
 * Branches dont on lit les commits par tour, et profondeur de cette lecture.
 *
 * ⚠️ `/commits` sans référence ne rend que la branche **par défaut** : tout ce
 * qui ne vit que sur une branche de travail resterait invisible. On repasse donc
 * derrière, branche par branche.
 *
 * Le coût est nul en régime établi — une branche dont on connaît déjà la tête
 * est sautée sans requête (voir `hasCommit`). Il ne se paie qu'au premier import
 * et quand une branche bouge, où deux pages couvrent très largement une
 * divergence ordinaire.
 */
const BRANCHES_PER_RUN = 10;
const BRANCH_PAGES = 2;

/**
 * Les étapes d'une synchronisation, dans l'ordre.
 *
 * Elles sont l'**unité de progression** rendue à l'interface : on ne sait pas
 * combien de commits le distant va rendre avant de les avoir lus, donc une
 * barre calée sur un total deviné mentirait. Une barre qui avance d'étape
 * nommée en étape nommée dit exactement où on en est.
 */
const SYNC_PHASES = ['Dépôt', 'Branches', 'Commits', 'Comparaison des branches', 'Releases', 'Pull requests'] as const;

/**
 * L'étape affichée entre deux tranches de rapatriement d'historique.
 *
 * C'est bien à celle-là qu'un backfill reprend : le dépôt, les branches et les
 * comparaisons sont déjà à jour, seule la lecture des commits anciens continue.
 */
const COMMITS_STEP = SYNC_PHASES.indexOf('Commits');

/**
 * Cibles de déploiement rapprochées par tour.
 *
 * Une cible = un appel tRPC. La borne existe pour qu'un espace à quarante cibles
 * ne produise pas quarante requêtes sortantes d'un coup ; celles qui n'ont pas
 * eu leur tour passeront au suivant, deux minutes plus tard.
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

/**
 * Branches comparées par tour à la branche par défaut.
 *
 * Chaque comparaison est un appel : un dépôt à cinquante branches ne doit pas
 * consommer cinquante requêtes par tour. Celles dont le sha n'a pas bougé sont
 * de toute façon sautées ; cette borne ne concerne que le premier tour et les
 * rafales de nouvelles branches, qui rattraperont au tour suivant.
 */
const MAX_COMPARISONS_PER_RUN = 12;

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

export interface IntegrationSyncDeps {
    db: Database;
    crypt: Encryption;
    logger: Logger;
    live?: LiveHub;
}

export class IntegrationSyncService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private deployTimer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
    /** Garde de ré-entrance propre au déploiement : son tour a sa propre durée. */
    private deployTicking = false;
    private readonly inFlight = new Map<number, Promise<void>>();
    private readonly ciphers = new Map<number, Cipher>();
    /** Dépôts à traiter en priorité, demandés à la main par `git.repoSyncNow`. */
    private readonly forced = new Set<number>();
    /**
     * L'étape en cours par dépôt, pour les synchronisations en vol.
     *
     * En mémoire et non en base : c'est un état de quelques secondes, lu par
     * sondage depuis l'interface qui a lancé la synchronisation. L'écrire en
     * base coûterait six écritures par tour pour une information périmée avant
     * d'être relue. Corollaire assumé, et vrai de tout le direct : derrière
     * deux instances, seule celle qui synchronise connaît l'avancement.
     */
    private readonly progress = new Map<number, { step: number; startedAt: number; workspaceId: number }>();

    /**
     * Dépôts dont l'historique n'est pas encore complet.
     *
     * Rempli par `runSync`, consommé à la fin de `syncOne` : c'est ce qui
     * enchaîne les tranches de backfill sans attendre la cadence ordinaire.
     */
    private readonly backfilling = new Set<number>();

    /**
     * Cibles de déploiement en recul, jusqu'à l'instant indiqué.
     *
     * En mémoire et non en base, comme `progress` : c'est l'état d'une instance
     * Dokploy injoignable *depuis ce processus*, pas un fait sur la cible. Le
     * garder ici évite surtout d'écrire dans `synced_at` un rapprochement qui
     * n'a pas eu lieu — ce qui ferait passer le premier import pour fait, et
     * transformerait tout l'historique de la cible en avis au tour suivant.
     */
    private readonly deployBackoff = new Map<number, number>();

    /** Le catalogue d'une instance, par jeton. Voir {@link DEPLOY_PLACE_TTL_SECONDS}. */
    private readonly deployPlaces = new Map<number, { at: number; targets: DokployTarget[] }>();

    constructor(private readonly deps: IntegrationSyncDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_SECONDS * 1000);
        this.timer.unref();
        // Son propre minuteur : voir {@link DEPLOY_TICK_SECONDS}. Un déploiement
        // se suit à la dizaine de secondes, un dépôt git à la dizaine de minutes.
        this.deployTimer = setInterval(() => void this.deployTick(), DEPLOY_TICK_SECONDS * 1000);
        this.deployTimer.unref();
        this.deps.logger.info(
            { tickSeconds: TICK_SECONDS, deployTickSeconds: DEPLOY_TICK_SECONDS },
            'Integration sync service started'
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.deployTimer) clearInterval(this.deployTimer);
        this.deployTimer = null;
    }

    /**
     * Demande explicite de l'utilisateur : le dépôt passe devant, et le tour
     * suivant démarre tout de suite au lieu d'attendre la cadence.
     */
    requestSync(repoId: number): void {
        this.forced.add(repoId);
        void this.tick();
    }

    /**
     * Déclenche un tour tout de suite, sans viser de dépôt.
     *
     * Sert au déclenchement d'un déploiement : il n'y a rien à synchroniser côté
     * git, seulement un suivi d'état à reprendre plus tôt que la cadence. La
     * garde de ré-entrance de `deployTick()` rend l'appel inoffensif s'il en
     * tourne déjà un.
     *
     * C'est aussi ce qui ouvre le message de suivi dans la seconde qui suit un
     * déclenchement parti d'ici, sans attendre le prochain battement.
     */
    wake(): void {
        void this.deployTick();
    }

    /**
     * Où en est la synchronisation de ce dépôt.
     *
     * `running: false` avec une étape nulle est la réponse normale hors
     * synchronisation — ce n'est pas une erreur, et l'interface s'en sert pour
     * savoir qu'elle peut cesser de sonder.
     */
    syncStatus(repoId: number): GitSyncStatus {
        const current = this.progress.get(repoId);
        if (!current) {
            return { running: false, phase: null, step: 0, stepCount: SYNC_PHASES.length, startedAt: null };
        }
        return {
            running: true,
            phase: SYNC_PHASES[Math.min(current.step, SYNC_PHASES.length - 1)],
            step: current.step,
            stepCount: SYNC_PHASES.length,
            startedAt: current.startedAt
        };
    }

    /**
     * Les synchronisations en cours dans un espace, toutes d'un coup.
     *
     * Lecture **purement mémoire** : aucune requête, aucun déchiffrement — d'où
     * le `workspaceId` mémorisé à côté de l'étape, qui évite d'avoir à demander
     * à la base quels dépôts appartiennent à qui. C'est ce qui rend la liste des
     * dépôts sondable à la seconde sans rien coûter, exactement comme la barre
     * de progression d'une synchro mail (voir LIVE.md, « les sondages
     * supprimés » : celui-ci lit un compteur qui ne vit qu'en mémoire le temps
     * de la synchro, et s'arrête avec elle).
     */
    runningIn(workspaceId: number): { repoId: number; phase: string; step: number; stepCount: number }[] {
        const out: { repoId: number; phase: string; step: number; stepCount: number }[] = [];
        for (const [repoId, current] of this.progress) {
            if (current.workspaceId !== workspaceId) continue;
            out.push({
                repoId,
                phase: SYNC_PHASES[Math.min(current.step, SYNC_PHASES.length - 1)],
                step: current.step,
                stepCount: SYNC_PHASES.length
            });
        }
        return out;
    }

    private cipherFor(workspaceId: number): Cipher {
        let cipher = this.ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(this.deps.db, this.deps.crypt, workspaceId);
            this.ciphers.set(workspaceId, cipher);
        }
        return cipher;
    }

    /**
     * Le tour du déploiement : rapprocher les cibles, entretenir les messages.
     *
     * Sa propre garde de ré-entrance, distincte de celle des dépôts. Un tour qui
     * lit la queue du journal de plusieurs déploiements en vol peut dépasser son
     * intervalle ; il saute alors un battement plutôt que de se chevaucher —
     * deux tours concurrents publieraient deux messages pour le même
     * déploiement, chacun ignorant l'identifiant que l'autre vient d'écrire.
     */
    private async deployTick(): Promise<void> {
        if (this.deployTicking) return;
        this.deployTicking = true;
        try {
            await this.syncDeployTargets();
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Deploy sync: tick failed');
        } finally {
            this.deployTicking = false;
        }
    }

    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const due = await this.deps.db.git.listDue(BATCH * 4);
            const now = Math.floor(Date.now() / 1000);
            const picked = due
                .filter((row) => {
                    if (this.forced.has(row.id)) return true;
                    return row.last_sync_at === null || now - row.last_sync_at >= MIN_INTERVAL_SECONDS;
                })
                .slice(0, BATCH);

            await Promise.all(picked.map((row) => this.syncOne(row.id, row.workspace_id)));
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Integration sync: tick failed');
        } finally {
            this.ticking = false;
        }
    }

    private syncOne(repoId: number, workspaceId: number): Promise<void> {
        const running = this.inFlight.get(repoId);
        if (running) return running;
        // Une tranche de backfill enchaîne la précédente : elle reprend son
        // horodatage de départ, sinon le chronomètre affiché repartirait de zéro
        // toutes les trois secondes alors qu'il s'agit d'une seule opération.
        const startedAt = this.progress.get(repoId)?.startedAt ?? Math.floor(Date.now() / 1000);
        this.progress.set(repoId, { step: 0, startedAt, workspaceId });
        const task = this.runSync(repoId, workspaceId).finally(() => {
            this.inFlight.delete(repoId);
            this.forced.delete(repoId);

            // L'historique n'est pas fini de rapatrier : on reprend là où on
            // s'est arrêté, sans attendre les dix minutes du régime ordinaire.
            if (this.backfilling.delete(repoId)) {
                // L'entrée d'avancement **survit** à la tranche. Sans cela,
                // l'interface voyait « plus rien en cours » pendant les trois
                // secondes de répit, en concluait que c'était terminé et retirait
                // sa barre de progression au milieu d'un rapatriement qui allait
                // durer encore plusieurs minutes.
                this.progress.set(repoId, { step: COMMITS_STEP, startedAt, workspaceId });

                // Appel direct plutôt que `forced` + `tick()` : la reprise ne
                // doit dépendre ni de la garde de ré-entrance d'un tour en
                // cours, ni de la place du dépôt dans `listDue` — il vient
                // justement d'être synchronisé, donc il y trie en dernier. Une
                // tranche perdue laisserait l'historique incomplet **et**, depuis
                // que l'avancement survit ci-dessus, une barre qui n'avance plus.
                const timer = setTimeout(() => void this.syncOne(repoId, workspaceId), BACKFILL_GAP_MS);
                // `unref` : une tranche en attente ne doit pas retenir le
                // processus à l'arrêt.
                timer.unref();
            } else {
                // Dans le `finally` : un échec doit lever le voile de chargement
                // aussi sûrement qu'un succès, sinon l'interface sonde à vide.
                this.progress.delete(repoId);
            }
        });
        this.inFlight.set(repoId, task);
        return task;
    }

    /** Avance l'étape affichée. Sans effet si la synchronisation est finie. */
    private advance(repoId: number, step: number): void {
        const current = this.progress.get(repoId);
        if (current) current.step = step;
    }

    private async runSync(repoId: number, workspaceId: number): Promise<void> {
        const cipher = this.cipherFor(workspaceId);
        const repo = await this.deps.db.git.findRepo(repoId, workspaceId);
        if (!repo || repo.credential_id === null) return;

        const now = Math.floor(Date.now() / 1000);
        try {
            const target = await this.readJson<{ owner: string; repo: string }>(cipher, repo.content);
            if (!target?.owner || !target.repo) throw new Error('Dépôt illisible.');

            const credential = await this.deps.db.credentials.findAny(repo.credential_id, workspaceId);
            if (!credential) throw new Error('Le jeton d’accès a été retiré.');
            const token = await cipher.decrypt(credential.secret_enc);

            const state = (await this.readJson<GitHubSyncState>(cipher, repo.sync_state)) ?? {};
            const next: GitHubSyncState = { ...state };
            let changed = false;

            // -- dépôt : branche par défaut
            this.advance(repoId, 0);
            const info = await fetchRepoInfo(target.owner, target.repo, token, state.repoEtag);
            next.repoEtag = info.etag ?? undefined;
            const defaultBranch = info.data?.defaultBranch ?? repo.default_branch;

            // -- branches
            this.advance(repoId, 1);
            const branches = await fetchBranches(target.owner, target.repo, token, state.branchesEtag);
            next.branchesEtag = branches.etag ?? undefined;
            if (branches.data) {
                const keep: string[] = [];
                for (const branch of branches.data) {
                    const ref = nameRef(branch.name);
                    keep.push(ref);
                    await this.deps.db.git.upsertBranch({
                        repoId,
                        workspaceId,
                        nameRef: ref,
                        headSha: branch.headSha,
                        isDefault: branch.name === defaultBranch,
                        updatedAt: now,
                        content: await cipher.encrypt(JSON.stringify({ name: branch.name }))
                    });
                }
                // Une branche fusionnée puis supprimée ne doit pas rester dans
                // la liste : le cache suit le distant, il ne l'accumule pas.
                await this.deps.db.git.pruneBranches(repoId, keep);
                changed = true;
            }

            // -- commits : la tête, puis une tranche d'historique
            this.advance(repoId, 2);
            const newest = await this.deps.db.git.latestCommitAt(repoId);

            // La tête. Sautée au tout premier tour : sans commit connu, il n'y a
            // pas de « depuis », et la passe de backfill ci-dessous part elle
            // aussi de HEAD — les deux liraient exactement la même chose.
            if (newest !== null) {
                const head = await fetchCommits(target.owner, target.repo, token, { since: newest }, HEAD_PAGES);
                if (await this.storeCommits(repoId, workspaceId, cipher, head.commits)) changed = true;
            }

            // La queue. On remonte le temps par tranches jusqu'à toucher le
            // premier commit du dépôt. Sans cette passe, un dépôt n'aurait
            // jamais que ses commits récents : le premier tour en lisait mille,
            // et tous les suivants repartaient du plus récent connu.
            if (state.backfillDone !== true) {
                // La borne vient de l'état de synchronisation, jamais du cache :
                // celui-ci mêle les commits de toutes les branches, et son
                // minimum global ferait sauter des tranches de la principale.
                const bound = state.backfillUntil;
                const tail = await fetchCommits(
                    target.owner,
                    target.repo,
                    token,
                    bound === undefined ? {} : { until: bound },
                    BACKFILL_PAGES
                );
                if (await this.storeCommits(repoId, workspaceId, cipher, tail.commits)) changed = true;

                const oldest = tail.commits.length > 0 ? Math.min(...tail.commits.map((c) => c.committedAt)) : null;
                // Trois façons d'avoir fini. Le distant n'a plus rien
                // (`exhausted`), la tranche est vide, ou la borne n'a pas reculé
                // — ce dernier cas protège d'une boucle sans fin quand plus de
                // `BACKFILL_PAGES` pages partagent la même seconde.
                if (tail.exhausted || oldest === null || (bound !== undefined && oldest >= bound)) {
                    next.backfillDone = true;
                    this.deps.logger.info({ repoId }, 'Integration sync: historique git complet');
                } else {
                    next.backfillUntil = oldest;
                    this.backfilling.add(repoId);
                }
            }

            // -- commits vivant sur les autres branches
            //
            // Sans cette passe, un dépôt n'aurait que l'historique de sa branche
            // par défaut : c'est tout ce que `/commits` rend quand on ne lui
            // précise pas de référence. Les branches de travail non fusionnées
            // manquaient donc entièrement.
            if (await this.syncBranchCommits(repoId, workspaceId, cipher, target, token)) changed = true;

            // -- avance / retard des branches sur la branche par défaut
            this.advance(repoId, 3);
            if (defaultBranch && (await this.compareBranches(repoId, workspaceId, target, token, defaultBranch))) {
                changed = true;
            }

            // -- releases
            this.advance(repoId, 4);
            const releases = await fetchReleases(target.owner, target.repo, token, state.releasesEtag);
            next.releasesEtag = releases.etag ?? undefined;
            if (releases.data) {
                for (const release of releases.data) {
                    await this.deps.db.git.upsertRelease({
                        repoId,
                        workspaceId,
                        tagRef: nameRef(release.tag),
                        publishedAt: release.publishedAt,
                        isPrerelease: release.isPrerelease,
                        content: await cipher.encrypt(
                            JSON.stringify({
                                tag: release.tag,
                                name: release.name,
                                body: release.body,
                                url: release.url
                            })
                        )
                    });
                }
                changed = true;
                await this.applyReleaseVersion(repoId, workspaceId, cipher);
            }

            // -- pull requests
            this.advance(repoId, 5);
            const pulls = await fetchPullRequests(target.owner, target.repo, token, state.pullsEtag);
            next.pullsEtag = pulls.etag ?? undefined;
            if (pulls.data) {
                for (const pull of pulls.data) {
                    await this.deps.db.git.upsertPullRequest({
                        repoId,
                        workspaceId,
                        number: pull.number,
                        state: pull.state,
                        // Le login est un identifiant public : on ne le garde
                        // en clair pas plus que l'adresse d'un auteur de commit.
                        authorRef: pull.authorLogin ? nameRef(pull.authorLogin) : null,
                        createdAt: pull.createdAt,
                        updatedAt: pull.updatedAt,
                        mergedAt: pull.mergedAt,
                        closedAt: pull.closedAt,
                        content: await cipher.encrypt(
                            JSON.stringify({
                                title: pull.title,
                                body: pull.body,
                                authorName: pull.authorLogin,
                                headBranch: pull.headBranch,
                                baseBranch: pull.baseBranch,
                                url: pull.url
                            })
                        )
                    });
                }
                changed = true;
            }

            await this.deps.db.git.markSynced(repoId, {
                at: now,
                error: null,
                syncState: await cipher.encrypt(JSON.stringify(next)),
                defaultBranch
            });

            // Ne réveiller l'espace que si quelque chose a bougé : un tour qui
            // n'a rencontré que des 304 ne doit faire re-solliciter personne.
            //
            // Les deux sujets : `git` pour la feature elle-même, `projects`
            // parce qu'une release peut avoir changé la version d'un projet lié
            // (voir `applyReleaseVersion`).
            if (changed) this.deps.live?.changed(workspaceId, ['git', 'projects'], null);
        } catch (e) {
            // Un tour qui échoue ne doit pas relancer une tranche trois secondes
            // plus tard : sur un quota épuisé, ce serait précisément la rafale
            // que le recul cherche à éviter. Le backfill reprendra au tour
            // ordinaire, `backfillDone` n'ayant pas été enregistré.
            this.backfilling.delete(repoId);
            const rateLimited = e instanceof GitHubError && e.rateLimited;
            const message = e instanceof Error ? e.message : 'Synchronisation impossible.';
            // Sur quota épuisé, on inscrit un horodatage **futur** : c'est le
            // seul moyen, avec un ordonnanceur qui trie par ancienneté, de faire
            // patienter ce dépôt sans bloquer les autres.
            const at = rateLimited ? now + RATE_LIMIT_BACKOFF_SECONDS : now;
            await this.deps.db.git
                .markSynced(repoId, {
                    at,
                    error: await this.cipherFor(workspaceId).encrypt(message),
                    syncState: repo.sync_state
                })
                .catch(() => {
                    /* la base est en cause : le tour suivant réessaiera */
                });
            this.deps.logger.warn({ err: e, repoId }, 'Integration sync: échec de synchronisation git');
        }
    }

    /**
     * Enregistre un lot de commits et leurs auteurs.
     *
     * Rend `true` si le lot n'était pas vide — c'est ce qui décide de réveiller
     * l'espace. `INSERT IGNORE` côté SQL : relire un commit déjà connu est le
     * cas **normal** ici, pas une erreur. Les deux passes (tête et queue) se
     * recouvrent d'ailleurs volontiers, la borne `until` du fournisseur étant
     * inclusive.
     */
    private async storeCommits(
        repoId: number,
        workspaceId: number,
        cipher: Cipher,
        commits: readonly GitHubCommit[]
    ): Promise<boolean> {
        for (const commit of commits) {
            const ref = authorRef(commit.authorEmail);
            await this.deps.db.git.upsertAuthor({
                repoId,
                workspaceId,
                authorRef: ref,
                content: await cipher.encrypt(JSON.stringify({ name: commit.authorName, email: commit.authorEmail }))
            });
            await this.deps.db.git.insertCommit({
                repoId,
                workspaceId,
                sha: commit.sha,
                committedAt: commit.committedAt,
                authorRef: ref,
                parents: commit.parents,
                content: await cipher.encrypt(
                    JSON.stringify({
                        message: commit.message,
                        authorName: commit.authorName,
                        authorEmail: commit.authorEmail,
                        url: commit.url
                    })
                )
            });
        }
        return commits.length > 0;
    }

    /**
     * Lit les commits propres aux branches autres que celle par défaut.
     *
     * Une branche dont la tête est **déjà connue** est sautée sans le moindre
     * appel : si on a son sommet, on a tout ce qu'elle porte. C'est ce qui rend
     * cette passe gratuite en régime établi et coûteuse seulement quand quelque
     * chose a bougé — ou au premier import, où elle est précisément ce qu'on
     * veut.
     *
     * Deux pages par branche : une divergence ordinaire tient largement dedans,
     * et ce qui dépasserait sera rattrapé au tour suivant, la tête n'ayant
     * toujours pas été enregistrée.
     */
    private async syncBranchCommits(
        repoId: number,
        workspaceId: number,
        cipher: Cipher,
        target: { owner: string; repo: string },
        token: string
    ): Promise<boolean> {
        const rows = await this.deps.db.git.listBranches(repoId, workspaceId);
        let budget = BRANCHES_PER_RUN;
        let changed = false;

        for (const row of rows) {
            if (budget <= 0) break;
            if (row.is_default === 1 || !row.head_sha) continue;
            if (await this.deps.db.git.hasCommit(repoId, row.head_sha)) continue;

            const name = (await this.readJson<{ name?: string }>(cipher, row.content))?.name;
            if (!name) continue;

            budget -= 1;
            try {
                const page = await fetchCommits(target.owner, target.repo, token, { ref: name }, BRANCH_PAGES);
                if (await this.storeCommits(repoId, workspaceId, cipher, page.commits)) changed = true;
            } catch (e) {
                // Un quota épuisé concerne tout le tour : on le laisse remonter.
                // Une branche qui refuse (supprimée entre-temps, référence
                // exotique) ne doit pas emporter les autres.
                if (e instanceof GitHubError && e.rateLimited) throw e;
                this.deps.logger.debug({ err: e, repoId }, 'Integration sync: branche ignorée');
            }
        }
        return changed;
    }

    /**
     * Recalcule l'avance et le retard de chaque branche sur la branche par
     * défaut, en sautant tout ce qui n'a pas bougé.
     *
     * Une comparaison coûte un appel, et le résultat ne change que si l'un des
     * deux côtés a bougé : on mémorise donc le couple `base..tête` qui l'a
     * produit et on ne recompare que lorsqu'il diffère. Sur un dépôt stable,
     * cette étape ne consomme rien du tout.
     *
     * Un échec sur une branche n'interrompt pas les autres : une branche
     * comparée reste plus utile qu'un tour entier abandonné. Le cas courant est
     * d'ailleurs banal — une branche partant d'un historique sans ancêtre commun
     * fait répondre 404 au fournisseur.
     *
     * Rend `true` si au moins une comparaison a changé quelque chose.
     */
    private async compareBranches(
        repoId: number,
        workspaceId: number,
        target: { owner: string; repo: string },
        token: string,
        defaultBranch: string
    ): Promise<boolean> {
        const rows = await this.deps.db.git.listBranches(repoId, workspaceId);
        const base = rows.find((row) => row.is_default === 1);
        // Sans branche par défaut connue, ou sans son sha, il n'y a rien à quoi
        // comparer : mieux vaut ne rien afficher qu'un compteur arbitraire.
        if (!base?.head_sha) return false;

        const cipher = this.cipherFor(workspaceId);
        let changed = false;
        let budget = MAX_COMPARISONS_PER_RUN;

        for (const row of rows) {
            if (budget <= 0) break;
            if (row.is_default === 1 || !row.head_sha) continue;
            const pair = `${base.head_sha}..${row.head_sha}`;
            if (row.compared_sha === pair) continue;

            const name = (await this.readJson<{ name?: string }>(cipher, row.content))?.name;
            if (!name) continue;

            budget -= 1;
            try {
                const diff = await fetchComparison(target.owner, target.repo, token, defaultBranch, name);
                await this.deps.db.git.setBranchComparison(repoId, row.name_ref, {
                    ahead: diff.ahead,
                    behind: diff.behind,
                    comparedSha: pair
                });
                changed = true;
            } catch (e) {
                // Un quota épuisé, lui, concerne tout le tour : on le laisse
                // remonter pour que l'ordonnanceur applique son recul.
                if (e instanceof GitHubError && e.rateLimited) throw e;
                this.deps.logger.debug({ err: e, repoId }, 'Integration sync: comparaison de branche ignorée');
            }
        }
        return changed;
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
        const due = await this.deps.db.deploy.listTargetsDue(DEPLOY_BATCH * 4, now - DEPLOY_MIN_INTERVAL_SECONDS);
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

        const cipher = this.cipherFor(target.workspace_id);
        const credential = await this.deps.db.credentials.findAny(target.credential_id, target.workspace_id);
        if (!credential?.base_url) return;
        const apiKey = await cipher.decrypt(credential.secret_enc);

        const remote = await listDeployments(
            credential.base_url,
            apiKey,
            target.target_kind === 'compose' ? 'compose' : 'application',
            target.external_id
        );

        // Le premier rapprochement **garnit sans prévenir** : tout l'historique
        // d'une cible est « nouveau » ce jour-là sans que rien ne vienne de se
        // produire, et l'annoncer serait un mensonge sur la date.
        const firstImport = target.synced_at === null;
        const local = await this.deps.db.deploy.listDeployments(
            target.id,
            target.workspace_id,
            DEPLOY_IMPORT_LIMIT * 3
        );

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
        const seen: { row: DeploymentRow; entry: DokployDeployment }[] = [];
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
                    const body = await this.readJson<Record<string, unknown>>(cipher, match.content);
                    await this.deps.db.deploy.updateDeployment(match.id, {
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
            const row = await this.deps.db.deploy.createRemoteDeployment({
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

            const body = await this.readJson<Record<string, unknown>>(cipher, row.content);
            await this.deps.db.deploy.updateDeployment(row.id, {
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
            await this.deps.db.deploy.markDeploymentNotified(row.id);
            changed = true;
        }

        await this.deps.db.deploy.markTargetSynced(target.id, now);

        if (changed) {
            // Les deux sujets : la fiche de la cible **et** l'onglet du projet
            // qui la déploie montrent le même état.
            this.deps.live?.changed(target.workspace_id, ['deploy', 'projects'], null);
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
     * `Services/discord.ts`). Quand le webhook réglé en est un, un déploiement
     * découvert **en vol** ouvre un message, que les tours suivants modifient —
     * barre d'avancement, temps écoulé, queue du journal — jusqu'à la conclusion,
     * qui remplace le tout par l'issue, la durée et l'erreur s'il y en a une.
     * L'identifiant du message vit dans le blob de la ligne, donc un serveur
     * redémarré en cours de route reprend le même message.
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
     * Corollaire à ne pas manquer : quand le suivi vivant a conclu, le webhook
     * est retiré de la livraison finale. Sans cela, Discord recevrait le message
     * modifié **et** un second message en clair juste en dessous.
     */
    private async updateDeployNotices(input: {
        target: DeployTargetSyncRow;
        baseUrl: string;
        apiKey: string;
        history: DeploymentRow[];
        seen: { row: DeploymentRow; entry: DokployDeployment }[];
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

        const cipher = this.cipherFor(target.workspace_id);
        const channels = await resolveChannels(this.deps.db, cipher, target.workspace_id, 'deploy');
        const discord = channels.webhook && isDiscordWebhook(channels.webhook) ? channels.webhook : null;
        const name = (await this.readJson<{ name?: string }>(cipher, target.content))?.name ?? target.external_id;
        const logger = this.deps.logger.child({ workspaceId: target.workspace_id, targetId: target.id });

        // Les journaux en parallèle : chaque lecture va au bout de son délai,
        // le flux d'un déploiement en cours ne se refermant pas de lui-même.
        // Les enchaîner ferait dépasser l'intervalle dès deux déploiements.
        if (discord) {
            await Promise.all(
                inFlight.map((item) =>
                    this.renderNotice({
                        ...input,
                        ...place,
                        item,
                        name,
                        webhook: discord,
                        cipher,
                        logger,
                        final: false
                    })
                )
            );
        }

        for (const item of landed) {
            if (!firstImport) {
                const closed = discord
                    ? await this.renderNotice({
                          ...input,
                          ...place,
                          item,
                          name,
                          webhook: discord,
                          cipher,
                          logger,
                          final: true
                      })
                    : false;
                // Le message vivant a conclu : le webhook a déjà tout dit, seul
                // le mail reste à servir. Sinon, l'avis ordinaire part sur tous
                // les canaux, comme avant le suivi vivant.
                if (closed) {
                    await deliver(
                        { ...channels, webhook: null },
                        this.deployAlert(name, {
                            status: item.entry.status,
                            title: item.entry.title,
                            description: item.entry.description,
                            startedAt: item.entry.startedAt,
                            finishedAt: item.entry.finishedAt
                        }),
                        logger
                    );
                } else if (hasChannel(channels)) {
                    await this.announceDeployment(target.workspace_id, cipher, name, {
                        status: item.entry.status,
                        title: item.entry.title,
                        description: item.entry.description,
                        startedAt: item.entry.startedAt,
                        finishedAt: item.entry.finishedAt
                    });
                }
            }
            // Marqué quoi qu'il advienne de l'envoi : `deliver` avale déjà ses
            // erreurs, et réessayer à chaque tour un canal mal réglé produirait
            // une boucle silencieuse plutôt qu'un rattrapage.
            await this.deps.db.deploy.markDeploymentNotified(item.row.id);
        }
    }

    /**
     * Publie ou modifie le message d'un déploiement. Rend `true` si Discord l'a
     * accepté.
     *
     * Le `false` compte : c'est lui qui fait retomber la conclusion sur l'avis
     * ordinaire, plutôt que de laisser un déploiement passer sous silence parce
     * que le message de suivi n'a pas pu s'ouvrir.
     */
    private async renderNotice(input: {
        baseUrl: string;
        apiKey: string;
        credentialId: number;
        externalId: string;
        kind: 'application' | 'compose';
        history: DeploymentRow[];
        item: { row: DeploymentRow; entry: DokployDeployment };
        name: string;
        webhook: string;
        cipher: Cipher;
        logger: Logger;
        final: boolean;
        now: number;
    }): Promise<boolean> {
        const { item, cipher, logger } = input;
        const blob = (await this.readJson<Record<string, unknown>>(cipher, item.row.content)) ?? {};
        const noticeId = typeof blob.noticeId === 'string' ? blob.noticeId : null;

        const [log, place] = await Promise.all([
            item.entry.logPath
                ? fetchDeploymentLog(input.baseUrl, input.apiKey, item.entry.logPath, {
                      timeoutMs: DEPLOY_LOG_TIMEOUT_MS
                  }).catch(() => '')
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

        if (noticeId !== null) return editMessage(input.webhook, noticeId, message, logger);

        const posted = await postMessage(input.webhook, message, logger);
        if (posted === null) return false;

        // Un déploiement conclu qu'on découvre après coup — le cas d'un
        // déploiement de huit secondes, commencé et fini entre deux battements —
        // reçoit le **même** message, publié une seule fois. Il n'a jamais rien
        // suivi, mais il n'y a aucune raison de le rendre plus pauvre que les
        // autres : c'était le défaut de la première version, qui le renvoyait
        // vers l'avis en texte brut.
        if (input.final) return true;

        // Retenu tout de suite : le tour suivant doit modifier ce message, et
        // non en poser un second à côté.
        await this.deps.db.deploy.setDeploymentContent(
            item.row.id,
            await cipher.encrypt(JSON.stringify({ ...blob, noticeId: posted }))
        );
        return true;
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
                cached = { at: now, targets: await listTargets(baseUrl, apiKey) };
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
     * Annonce un déploiement qui vient d'atterrir, sur les canaux de la feature
     * **Déploiement**.
     *
     * Ses propres canaux, jamais ceux d'Uptime : un déploiement raté ne concerne
     * ni les mêmes personnes ni le même salon qu'un service tombé. C'est le
     * travers corrigé pour Sentinelle en 075 et pour Bases de données en 085 ; il
     * n'y avait pas de raison de le refaire une troisième fois.
     */
    private async announceDeployment(
        workspaceId: number,
        cipher: Cipher,
        targetName: string,
        item: { status: string; title: string; description: string; startedAt: number; finishedAt: number | null }
    ): Promise<void> {
        const channels = await resolveChannels(this.deps.db, cipher, workspaceId, 'deploy');
        if (!hasChannel(channels)) return;
        await deliver(channels, this.deployAlert(targetName, item), this.deps.logger.child({ workspaceId }));
    }

    /**
     * Le corps de l'avis, en texte — mail, Slack, point d'entrée maison.
     *
     * Séparé de son envoi parce qu'il sert deux fois : l'avis ordinaire, et le
     * mail seul quand le suivi vivant a déjà conclu côté Discord. Le construire
     * aux deux endroits aurait garanti que l'un des deux finisse par oublier une
     * ligne.
     */
    private deployAlert(
        targetName: string,
        item: { status: string; title: string; description: string; startedAt: number; finishedAt: number | null }
    ): Alert {
        const failed = item.status === 'failed';
        const label = item.title || 'Déploiement';
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

    /**
     * Reporte la dernière release sur la version des projets qui ont demandé à
     * la suivre. Le champ devient alors piloté par le dépôt, et l'interface le
     * passe en lecture seule.
     *
     * **Tous** les projets liés, et non plus un seul : un dépôt sert désormais
     * plusieurs projets, et n'en servir qu'un serait arbitraire. La liste est
     * courte — et déjà filtrée sur l'étage ouvert, donc lisible sans session.
     */
    private async applyReleaseVersion(repoId: number, workspaceId: number, cipher: Cipher): Promise<void> {
        const usage = await this.deps.db.git.listUsage(repoId, workspaceId);
        if (usage.length === 0) return;

        const releases = await this.deps.db.git.listReleases(repoId, workspaceId);
        // La plus récente qui ne soit pas une pré-version : une release
        // candidate ne fait pas la version affichée d'un projet.
        const latest = releases.find((r) => r.is_prerelease === 0) ?? releases[0];
        if (!latest) return;

        const tag = (await this.readJson<{ tag?: string }>(cipher, latest.content))?.tag;
        if (!tag) return;

        for (const link of usage) {
            const project = await this.deps.db.projects.findById(link.project_id, workspaceId);
            if (!project || project.version_source !== 'github_release') continue;

            const body = await this.readJson<Record<string, unknown>>(cipher, project.content);
            if (!body || body.version === tag) continue;

            await this.deps.db.projects.update(project.id, workspaceId, {
                status: project.status,
                startDate: project.start_date,
                dueDate: project.due_date,
                content: await cipher.encrypt(JSON.stringify({ ...body, version: tag }))
            });
        }
    }

    /** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
    private async readJson<T>(cipher: Cipher, blob: string | null): Promise<T | null> {
        if (!blob) return null;
        const plain = await cipher.tryDecrypt(blob);
        if (plain === null) return null;
        try {
            return JSON.parse(plain) as T;
        } catch {
            return null;
        }
    }
}

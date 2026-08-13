import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { LiveHub } from '@/live/hub';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import type { Logger } from 'pino';
import type { GitSyncStatus } from 'deveye-types';
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
import { listDeployments } from './integrations/dokploy';

/**
 * Les intégrations externes, en tâche de fond : synchronisation des **dépôts
 * git de l'espace**, et suivi des **déploiements de projet** encore en vol.
 *
 * Les deux vivent dans le même service parce qu'ils ont exactement la même
 * forme — un minuteur, un budget d'appels, un fournisseur tiers qui répond
 * quand il veut — et non parce qu'ils parlent de la même chose. Structure
 * calquée sur {@link UptimeMonitor} : un minuteur `unref`é, une garde de
 * ré-entrance, une carte de promesses en vol pour ne jamais traiter deux fois
 * le même dépôt, et des chiffres mémoïsés par espace.
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
 * Branches comparées par tour à la branche par défaut.
 *
 * Chaque comparaison est un appel : un dépôt à cinquante branches ne doit pas
 * consommer cinquante requêtes par tour. Celles dont le sha n'a pas bougé sont
 * de toute façon sautées ; cette borne ne concerne que le premier tour et les
 * rafales de nouvelles branches, qui rattraperont au tour suivant.
 */
const MAX_COMPARISONS_PER_RUN = 12;

export interface IntegrationSyncDeps {
    db: Database;
    crypt: Encryption;
    logger: Logger;
    live?: LiveHub;
}

export class IntegrationSyncService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
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

    constructor(private readonly deps: IntegrationSyncDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_SECONDS * 1000);
        this.timer.unref();
        this.deps.logger.info({ tickSeconds: TICK_SECONDS }, 'Integration sync service started');
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
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
     * garde de ré-entrance de `tick()` rend l'appel inoffensif s'il en tourne
     * déjà un.
     */
    wake(): void {
        void this.tick();
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
            // Les déploiements en vol sont suivis à part : ils n'ont rien à voir
            // avec la cadence des dépôts, et un déploiement dure des minutes.
            await this.pollDeployments();
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
     * Réinterroge le fournisseur sur les déploiements encore en vol.
     *
     * DevEye ne reçoit aucun webhook : c'est donc du sondage, mais borné aux
     * seuls déploiements non terminés — il n'y en a jamais plus d'une poignée.
     */
    private async pollDeployments(): Promise<void> {
        const inFlight = await this.deps.db.deploy.listInFlight(10);
        for (const row of inFlight) {
            try {
                const cipher = this.cipherFor(row.workspace_id);
                const target = await this.deps.db.deploy.findTarget(row.target_id, row.workspace_id);
                if (!target || target.credential_id === null) continue;

                const credential = await this.deps.db.credentials.findAny(target.credential_id, row.workspace_id);
                if (!credential?.base_url) continue;
                const apiKey = await cipher.decrypt(credential.secret_enc);

                const remote = await listDeployments(
                    credential.base_url,
                    apiKey,
                    target.target_kind === 'compose' ? 'compose' : 'application',
                    target.external_id
                );
                // On rattache par identifiant externe quand on en a un, sinon
                // par proximité de date : Dokploy ne renvoie pas toujours
                // l'identifiant au déclenchement.
                const match =
                    (row.external_id !== null && remote.find((d) => d.externalId === row.external_id)) ||
                    remote.find((d) => Math.abs(d.startedAt - Number(row.started_at)) < 120);
                if (!match || match.status === row.status) continue;

                const body = await this.readJson<Record<string, unknown>>(cipher, row.content);
                await this.deps.db.deploy.updateDeployment(row.id, {
                    externalId: match.externalId ?? row.external_id,
                    status: match.status,
                    finishedAt: match.finishedAt,
                    content: await cipher.encrypt(JSON.stringify({ ...body, description: match.description }))
                });
                // Les deux sujets : la fiche de la cible **et** l'onglet du
                // projet qui la déploie montrent le même état.
                this.deps.live?.changed(row.workspace_id, ['deploy', 'projects'], null);
            } catch (e) {
                this.deps.logger.warn({ err: e, deploymentId: row.id }, 'Project sync: suivi de déploiement échoué');
            }
        }
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

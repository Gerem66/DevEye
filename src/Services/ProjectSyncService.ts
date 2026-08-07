import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { LiveHub } from '@/live/hub';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import type { Logger } from 'pino';
import {
    authorRef,
    fetchBranches,
    fetchCommits,
    fetchReleases,
    fetchRepoInfo,
    GitHubError,
    nameRef,
    type GitHubSyncState
} from './projectProviders/github';
import { listDeployments } from './projectProviders/dokploy';

/**
 * Synchronisation de fond des dépôts liés aux projets.
 *
 * Structure calquée sur {@link UptimeMonitor} : un minuteur `unref`é, une garde
 * de ré-entrance, une carte de promesses en vol pour ne jamais traiter deux
 * fois le même projet, et des chiffres mémoïsés par espace.
 *
 * **Ne traite que les projets à l'étage ouvert.** Un projet confidentiel est
 * chiffré sous la clé dérivée du mot de passe de son propriétaire : ce service
 * tourne sans session, il ne pourra jamais la lire. C'est la même règle que
 * `MailSyncService` applique aux comptes gardés, et elle est portée par la
 * requête `listDue` elle-même plutôt que par une garde ici — ainsi elle ne peut
 * pas être oubliée.
 */

/** Cadence de l'ordonnanceur. */
const TICK_SECONDS = 120;

/** Dépôts traités par tour : borne la rafale d'appels au fournisseur. */
const BATCH = 3;

/** Délai minimal entre deux synchronisations d'un même dépôt. */
const MIN_INTERVAL_SECONDS = 600;

/** Recul appliqué quand le fournisseur annonce un quota épuisé. */
const RATE_LIMIT_BACKOFF_SECONDS = 3600;

export interface ProjectSyncDeps {
    db: Database;
    crypt: Encryption;
    logger: Logger;
    live?: LiveHub;
}

export class ProjectSyncService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
    private readonly inFlight = new Map<number, Promise<void>>();
    private readonly ciphers = new Map<number, Cipher>();
    /** Projets à traiter en priorité, demandés à la main par `repoSyncNow`. */
    private readonly forced = new Set<number>();

    constructor(private readonly deps: ProjectSyncDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_SECONDS * 1000);
        this.timer.unref();
        this.deps.logger.info({ tickSeconds: TICK_SECONDS }, 'Project sync service started');
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * Demande explicite de l'utilisateur : le projet passe devant, et le tour
     * suivant démarre tout de suite au lieu d'attendre la cadence.
     */
    requestSync(projectId: number): void {
        this.forced.add(projectId);
        void this.tick();
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
            const due = await this.deps.db.projectGit.listDue(BATCH * 4);
            const now = Math.floor(Date.now() / 1000);
            const picked = due
                .filter((row) => {
                    if (this.forced.has(row.project_id)) return true;
                    return row.last_sync_at === null || now - row.last_sync_at >= MIN_INTERVAL_SECONDS;
                })
                .slice(0, BATCH);

            await Promise.all(picked.map((row) => this.syncOne(row.project_id, row.workspace_id)));
            // Les déploiements en vol sont suivis à part : ils n'ont rien à voir
            // avec la cadence des dépôts, et un déploiement dure des minutes.
            await this.pollDeployments();
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Project sync: tick failed');
        } finally {
            this.ticking = false;
        }
    }

    private syncOne(projectId: number, workspaceId: number): Promise<void> {
        const running = this.inFlight.get(projectId);
        if (running) return running;
        const task = this.runSync(projectId, workspaceId).finally(() => {
            this.inFlight.delete(projectId);
            this.forced.delete(projectId);
        });
        this.inFlight.set(projectId, task);
        return task;
    }

    private async runSync(projectId: number, workspaceId: number): Promise<void> {
        const cipher = this.cipherFor(workspaceId);
        const repo = await this.deps.db.projectGit.findRepo(projectId, workspaceId);
        if (!repo || repo.credential_id === null) return;

        const now = Math.floor(Date.now() / 1000);
        try {
            const target = await this.readJson<{ owner: string; repo: string }>(cipher, repo.content);
            if (!target?.owner || !target.repo) throw new Error('Dépôt lié illisible.');

            const credential = await this.deps.db.projectGit.findCredential(repo.credential_id, workspaceId);
            if (!credential) throw new Error('Le jeton d’accès a été retiré.');
            const token = await cipher.decrypt(credential.secret_enc);

            const state = (await this.readJson<GitHubSyncState>(cipher, repo.sync_state)) ?? {};
            const next: GitHubSyncState = { ...state };
            let changed = false;

            // -- dépôt : branche par défaut
            const info = await fetchRepoInfo(target.owner, target.repo, token, state.repoEtag);
            next.repoEtag = info.etag ?? undefined;
            const defaultBranch = info.data?.defaultBranch ?? repo.default_branch;

            // -- branches
            const branches = await fetchBranches(target.owner, target.repo, token, state.branchesEtag);
            next.branchesEtag = branches.etag ?? undefined;
            if (branches.data) {
                const keep: string[] = [];
                for (const branch of branches.data) {
                    const ref = nameRef(branch.name);
                    keep.push(ref);
                    await this.deps.db.projectGit.upsertBranch({
                        projectId,
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
                await this.deps.db.projectGit.pruneBranches(projectId, keep);
                changed = true;
            }

            // -- commits, à partir du dernier connu
            const since = await this.deps.db.projectGit.latestCommitAt(projectId);
            const commits = await fetchCommits(target.owner, target.repo, token, since ?? undefined);
            for (const commit of commits) {
                const ref = authorRef(commit.authorEmail);
                await this.deps.db.projectGit.upsertAuthor({
                    projectId,
                    workspaceId,
                    authorRef: ref,
                    content: await cipher.encrypt(
                        JSON.stringify({ name: commit.authorName, email: commit.authorEmail })
                    )
                });
                await this.deps.db.projectGit.insertCommit({
                    projectId,
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
            if (commits.length > 0) changed = true;

            // -- releases
            const releases = await fetchReleases(target.owner, target.repo, token, state.releasesEtag);
            next.releasesEtag = releases.etag ?? undefined;
            if (releases.data) {
                for (const release of releases.data) {
                    await this.deps.db.projectGit.upsertRelease({
                        projectId,
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
                await this.applyReleaseVersion(projectId, workspaceId, cipher);
            }

            await this.deps.db.projectGit.markSynced(projectId, {
                at: now,
                error: null,
                syncState: await cipher.encrypt(JSON.stringify(next)),
                defaultBranch
            });

            // Ne réveiller l'espace que si quelque chose a bougé : un tour qui
            // n'a rencontré que des 304 ne doit faire re-solliciter personne.
            if (changed) this.deps.live?.changed(workspaceId, ['projects'], null);
        } catch (e) {
            const rateLimited = e instanceof GitHubError && e.rateLimited;
            const message = e instanceof Error ? e.message : 'Synchronisation impossible.';
            // Sur quota épuisé, on inscrit un horodatage **futur** : c'est le
            // seul moyen, avec un ordonnanceur qui trie par ancienneté, de faire
            // patienter ce dépôt sans bloquer les autres.
            const at = rateLimited ? now + RATE_LIMIT_BACKOFF_SECONDS : now;
            await this.deps.db.projectGit
                .markSynced(projectId, {
                    at,
                    error: await this.cipherFor(workspaceId).encrypt(message),
                    syncState: repo.sync_state
                })
                .catch(() => {
                    /* la base est en cause : le tour suivant réessaiera */
                });
            this.deps.logger.warn({ err: e, projectId }, 'Project sync: échec');
        }
    }

    /**
     * Réinterroge le fournisseur sur les déploiements encore en vol.
     *
     * DevEye ne reçoit aucun webhook : c'est donc du sondage, mais borné aux
     * seuls déploiements non terminés — il n'y en a jamais plus d'une poignée.
     */
    private async pollDeployments(): Promise<void> {
        const inFlight = await this.deps.db.projectDeploy.listInFlight(10);
        for (const row of inFlight) {
            try {
                const cipher = this.cipherFor(row.workspace_id);
                const target = await this.deps.db.projectDeploy.findTarget(row.project_id, row.workspace_id);
                if (!target || target.credential_id === null) continue;

                const credential = await this.deps.db.projectGit.findCredential(target.credential_id, row.workspace_id);
                if (!credential?.base_url) continue;
                const apiKey = await cipher.decrypt(credential.secret_enc);

                const remote = await listDeployments(credential.base_url, apiKey, target.external_id);
                // On rattache par identifiant externe quand on en a un, sinon
                // par proximité de date : Dokploy ne renvoie pas toujours
                // l'identifiant au déclenchement.
                const match =
                    (row.external_id !== null && remote.find((d) => d.externalId === row.external_id)) ||
                    remote.find((d) => Math.abs(d.startedAt - Number(row.started_at)) < 120);
                if (!match || match.status === row.status) continue;

                const body = await this.readJson<Record<string, unknown>>(cipher, row.content);
                await this.deps.db.projectDeploy.updateDeployment(row.id, {
                    externalId: match.externalId ?? row.external_id,
                    status: match.status,
                    finishedAt: match.finishedAt,
                    content: await cipher.encrypt(JSON.stringify({ ...body, description: match.description }))
                });
                this.deps.live?.changed(row.workspace_id, ['projects'], null);
            } catch (e) {
                this.deps.logger.warn({ err: e, deploymentId: row.id }, 'Project sync: suivi de déploiement échoué');
            }
        }
    }

    /**
     * Reporte la dernière release sur la version du projet, quand celui-ci a
     * demandé à la suivre. Le champ devient alors piloté par le dépôt, et
     * l'interface le passe en lecture seule.
     */
    private async applyReleaseVersion(projectId: number, workspaceId: number, cipher: Cipher): Promise<void> {
        const project = await this.deps.db.projects.findById(projectId, workspaceId);
        if (!project || project.version_source !== 'github_release') return;

        const releases = await this.deps.db.projectGit.listReleases(projectId, workspaceId);
        // La plus récente qui ne soit pas une pré-version : une release
        // candidate ne fait pas la version affichée d'un projet.
        const latest = releases.find((r) => r.is_prerelease === 0) ?? releases[0];
        if (!latest) return;

        const payload = await this.readJson<{ tag?: string }>(cipher, latest.content);
        const tag = payload?.tag;
        if (!tag) return;

        const body = await this.readJson<Record<string, unknown>>(cipher, project.content);
        if (!body || body.version === tag) return;

        await this.deps.db.projects.update(projectId, workspaceId, {
            status: project.status,
            startDate: project.start_date,
            dueDate: project.due_date,
            content: await cipher.encrypt(JSON.stringify({ ...body, version: tag }))
        });
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

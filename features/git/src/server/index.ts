import {
    GIT_ITEMS_PROVIDER,
    type DeployActivity,
    type GitItemsProvider,
    type GitRepoDescription
} from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import type { GitRepoRow } from '../contracts/domain';
import { gitAccountExport } from './accountExport';
import { fetchDeployments, fetchWorkflowRuns, GitHubError, type GitHubDeployEvent } from './github';
import { gitHandlers } from './handlers';
import { gitCopy } from './copy';
import { gitMove } from './move';
import { createRepo, type GitRepo } from './repo';
import { GitSync } from './service';
import { readJson, setSync, type StoredRepo } from './_shared';

/**
 * Un dépôt lu chez lui, déchiffré par le codec ouvert de son domicile : son
 * nom (`owner/repo`), d'où le cloner, sa branche par défaut. Un dépôt disparu
 * ou un blob illisible vaut `null`, jamais une exception : l'appelant le
 * montre comme une cible disparue.
 */
async function describeRepo(
    repo: GitRepo,
    cipher: SdkCipher,
    repoId: number,
    workspaceId: number
): Promise<{ row: GitRepoRow; description: GitRepoDescription } | null> {
    const row = await repo.findRepo(repoId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredRepo>>(cipher, row.content);
    if (!stored?.owner || !stored.repo) return null;
    const slug = `${stored.owner}/${stored.repo}`;
    return {
        row,
        description: {
            workspaceId: row.workspace_id,
            label: slug,
            cloneUrl: `https://github.com/${slug}.git`,
            webUrl: `https://github.com/${slug}`,
            defaultBranch: row.default_branch
        }
    };
}

/** Le nom d'un dépôt, servi à l'entrée `items` comme au contrat offert aux autres features. */
async function labelOf(repo: GitRepo, cipher: SdkCipher, repoId: number, workspaceId: number): Promise<string | null> {
    return (await describeRepo(repo, cipher, repoId, workspaceId))?.description.label ?? null;
}

/** Le jeton de l'accès d'un dépôt, `null` pour un dépôt public ou un secret illisible. */
async function tokenOf(repo: GitRepo, cipher: SdkCipher, row: GitRepoRow, workspaceId: number): Promise<string | null> {
    if (row.credential_id === null) return null;
    const credential = await repo.findCredential(row.credential_id, workspaceId);
    return credential ? cipher.tryDecrypt(credential.secret_enc) : null;
}

/** Un « en cours » parti avant n'aboutira plus : GitHub l'a perdu ou oublié. */
const IN_FLIGHT_HORIZON_SECONDS = 6 * 3600;

/** Ce que les workflows et déploiements lus disent de la fenêtre qui commence à `since`. */
export function summarizeActivity(
    events: readonly GitHubDeployEvent[],
    since: number,
    label: string,
    now: number
): Pick<DeployActivity, 'succeeded' | 'inFlight'> {
    let succeeded: DeployActivity['succeeded'] = null;
    let inFlight: DeployActivity['inFlight'] = null;
    for (const event of events) {
        const what = `${event.what} de ${label}`;
        if (event.state === 'success' && event.at >= since && (!succeeded || event.at > succeeded.at)) {
            succeeded = { at: event.at, what };
        } else if (event.state === 'running' && event.at >= now - IN_FLIGHT_HORIZON_SECONDS) {
            inFlight ??= { what };
        }
    }
    return { succeeded, inFlight };
}

/** Un refus de GitHub dit quel droit manque au jeton ; le reste se dit tel quel. */
function readFailure(e: unknown, label: string, what: string, right: string): string {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !e.rateLimited) {
        return `Dépôt ${label} : le jeton ne lit pas ${what} (droit ${right} en lecture)`;
    }
    return `Dépôt ${label} : ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * L'entrée serveur du module : la synchronisation de fond des dépôts chez GitHub
 * (`GitSync`), le singleton qu'elle pose pour les handlers, et le contrat offert
 * aux autres features (un dépôt existe-t-il ici, comment s'appelle-t-il, et
 * pour un service sans session, d'où le cloner et avec quel jeton).
 *
 * Pas de `migrationsDir` : les tables du module datent du socle (allowlist dans
 * `deveye-feature.json`) ; une nouvelle table inaugurera `src/server/migrations/`
 * avec le préfixe `ft_git_`.
 */
export const serverEntry: FeatureServer<GitRepo> = {
    createRepo,
    features: gitHandlers,
    createService(deps) {
        const sync = new GitSync(deps);
        // Visible d'ici, chez lui ou projeté : un projet relie ce que son espace
        // voit. Le nom se lit sous le codec du domicile, seul à savoir l'ouvrir.
        const items: GitItemsProvider = {
            exists: async (repoId, workspaceId) => (await deps.repo.findVisibleRepo(repoId, workspaceId)) !== null,
            labelOf: async (repoId, workspaceId) => {
                const row = await deps.repo.findVisibleRepo(repoId, workspaceId);
                return row ? labelOf(deps.repo, deps.cipherFor(row.workspace_id), repoId, row.workspace_id) : null;
            },
            listHome: async (workspaceIds) =>
                (await deps.repo.listHomeRepos(workspaceIds)).map((r) => ({
                    id: Number(r.id),
                    workspaceId: Number(r.workspace_id),
                    headSha: r.head_sha,
                    headSeenAt: r.head_seen_at === null ? null : Number(r.head_seen_at)
                })),
            describe: async (repoId, workspaceId) =>
                (await describeRepo(deps.repo, deps.cipherFor(workspaceId), repoId, workspaceId))?.description ?? null,
            openCheckout: async (repoId, workspaceId) => {
                const cipher = deps.cipherFor(workspaceId);
                const found = await describeRepo(deps.repo, cipher, repoId, workspaceId);
                if (!found) return null;
                return { ...found.description, token: await tokenOf(deps.repo, cipher, found.row, workspaceId) };
            },
            list: async (workspaceId) => {
                const cipher = deps.cipherFor(workspaceId);
                const rows = await deps.repo.listRepos(workspaceId);
                return Promise.all(
                    rows.map(async (row) => ({
                        id: row.id,
                        name: (await labelOf(deps.repo, cipher, row.id, workspaceId)) ?? `Dépôt ${row.id}`,
                        detail: null
                    }))
                );
            },
            authorize: async (repoId, workspaceId, userId) => {
                if (!(await deps.repo.findVisibleRepo(repoId, workspaceId))) return { ok: false, reason: 'hidden' };
                return deps.access.feature(workspaceId, userId, { level: 'read', itemId: String(repoId) });
            },
            activity: async (repoId, workspaceId, since) => {
                const visible = await deps.repo.findVisibleRepo(repoId, workspaceId);
                const home = visible?.workspace_id ?? workspaceId;
                const cipher = deps.cipherFor(home);
                const found = visible ? await describeRepo(deps.repo, cipher, repoId, home) : null;
                if (!found) return { succeeded: null, inFlight: null, error: null };
                const { label, defaultBranch } = found.description;
                const [owner, name] = label.split('/');
                const token = await tokenOf(deps.repo, cipher, found.row, home);
                const [runs, deployments] = await Promise.allSettled([
                    defaultBranch ? fetchWorkflowRuns(owner, name, token, defaultBranch) : Promise.resolve([]),
                    fetchDeployments(owner, name, token, since)
                ]);
                const errors: string[] = [];
                if (runs.status === 'rejected')
                    errors.push(readFailure(runs.reason, label, 'les workflows', 'Actions'));
                if (deployments.status === 'rejected') {
                    errors.push(readFailure(deployments.reason, label, 'les déploiements', 'Deployments'));
                }
                const events = [
                    ...(runs.status === 'fulfilled' ? runs.value : []),
                    ...(deployments.status === 'fulfilled' ? deployments.value : [])
                ];
                return {
                    ...summarizeActivity(events, since, label, Math.floor(Date.now() / 1000)),
                    error: errors.length > 0 ? errors.join(' ; ') : null
                };
            }
        };
        return {
            start() {
                setSync(sync);
                sync.start();
            },
            async stop() {
                await sync.stop();
                setSync(null);
            },
            providers: { [GIT_ITEMS_PROVIDER]: items }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleRepo(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId),
        move: gitMove,
        copy: gitCopy
    },
    quotas: { repos: { list: (repo, owned) => repo.listStockRepos(owned) } },
    accountExport: gitAccountExport
};

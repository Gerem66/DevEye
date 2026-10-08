import { GIT_ITEMS_PROVIDER, type GitItemsProvider, type GitRepoDescription } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import type { GitRepoRow } from '../contracts/domain';
import { gitAccountExport } from './accountExport';
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
                    headSha: r.head_sha
                })),
            describe: async (repoId, workspaceId) =>
                (await describeRepo(deps.repo, deps.cipherFor(workspaceId), repoId, workspaceId))?.description ?? null,
            openCheckout: async (repoId, workspaceId) => {
                const cipher = deps.cipherFor(workspaceId);
                const found = await describeRepo(deps.repo, cipher, repoId, workspaceId);
                if (!found) return null;
                let token: string | null = null;
                if (found.row.credential_id !== null) {
                    const credential = await deps.repo.findCredential(found.row.credential_id, workspaceId);
                    token = credential ? await cipher.tryDecrypt(credential.secret_enc) : null;
                }
                return { ...found.description, token };
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

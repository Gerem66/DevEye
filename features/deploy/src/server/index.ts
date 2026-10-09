import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { deployAccountExport } from './accountExport';
import { deployHandlers } from './handlers';
import { deployCopy } from './copy';
import { deployMove } from './move';
import { createRepo, type DeployRepo } from './repo';
import { DeploySync } from './service';
import { readJson, setSync, type StoredTarget } from './_shared';

/**
 * Le nom d'une cible, déchiffré par `cipher` (le codec ouvert de son domicile).
 * Une cible disparue ou un blob illisible vaut `null`, jamais une exception.
 * Sert à l'entrée `items` et au contrat offert à Projets.
 */
async function labelOf(
    repo: DeployRepo,
    cipher: SdkCipher,
    targetId: number,
    workspaceId: number
): Promise<string | null> {
    const row = await repo.findTarget(targetId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredTarget>>(cipher, row.content);
    return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
}

const PROVIDER_NAMES: Record<string, string> = { dokploy: 'Dokploy', github: 'GitHub Actions', agent: 'Machine' };

/** Ce qu'un rapprochement à la demande peut prendre avant qu'on réponde sur ce que la base sait. */
const REFRESH_BUDGET_MS = 10_000;

/** Un déploiement « en cours » parti avant reste en base sans que personne ne le fasse aboutir. */
const IN_FLIGHT_HORIZON_SECONDS = 6 * 3600;

/**
 * L'entrée serveur du module : le rapprochement de fond des cibles chez leur
 * fournisseur (`DeploySync`, posé en singleton pour que `deploy.trigger`
 * réveille un tour), le contrat offert à Projets (`DEPLOY_ITEMS_PROVIDER`) et
 * l'entrée `items` qu'exige `shareTier: 'open'` (domicile et nom d'une cible
 * visible d'ici).
 *
 * `deploy_targets`, `deployments` et `ft_deploy_credentials` datent du socle
 * (allowlist dans deveye-feature.json) ; `migrations/` les fait évoluer, et une
 * table neuve y prendra le préfixe `ft_deploy_`. `project_deploy_links`
 * appartient à Projets.
 */
export const serverEntry: FeatureServer<DeployRepo> = {
    createRepo,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    features: deployHandlers,
    createService(deps) {
        const sync = new DeploySync(deps);
        // Projets ne stocke que des identifiants : il demande si la cible est
        // visible de son espace, chez elle ou projetée, pour qu'un identifiant
        // étranger ne se relie pas ; et son nom, sous le codec ouvert du
        // domicile, seul à savoir l'ouvrir.
        const items: DeployItemsProvider = {
            exists: async (targetId, workspaceId) =>
                (await deps.repo.findVisibleTarget(targetId, workspaceId)) !== null,
            labelOf: async (targetId, workspaceId) => {
                const row = await deps.repo.findVisibleTarget(targetId, workspaceId);
                return row ? labelOf(deps.repo, deps.cipherFor(row.workspace_id), targetId, row.workspace_id) : null;
            },
            list: async (workspaceId) => {
                const cipher = deps.cipherFor(workspaceId);
                const rows = await deps.repo.listTargets(workspaceId);
                return Promise.all(
                    rows.map(async (row) => ({
                        id: row.id,
                        name: (await labelOf(deps.repo, cipher, row.id, workspaceId)) ?? `Cible ${row.id}`,
                        detail: PROVIDER_NAMES[row.provider] ?? null
                    }))
                );
            },
            authorize: async (targetId, workspaceId, userId) => {
                if (!(await deps.repo.findVisibleTarget(targetId, workspaceId))) return { ok: false, reason: 'hidden' };
                return deps.access.feature(workspaceId, userId, { level: 'read', itemId: String(targetId) });
            },
            activity: async (targetId, workspaceId, since) => {
                const row = await deps.repo.findVisibleTarget(targetId, workspaceId);
                if (!row) return { succeeded: null, inFlight: null, error: null };
                // Borné : une instance lente ne retient pas la sonde d'Uptime qui pose la question.
                await Promise.race([
                    sync.refresh(targetId),
                    new Promise((r) => setTimeout(r, REFRESH_BUDGET_MS).unref())
                ]);
                const name = await labelOf(deps.repo, deps.cipherFor(row.workspace_id), targetId, row.workspace_id);
                const what = `le déploiement « ${name ?? `cible ${targetId}`} »`;
                const now = Math.floor(Date.now() / 1000);
                const found = await deps.repo.deploymentActivity(targetId, since, now - IN_FLIGHT_HORIZON_SECONDS);
                return {
                    succeeded: found.succeededAt === null ? null : { at: found.succeededAt, what },
                    inFlight: found.inFlight > 0 ? { what } : null,
                    error: null
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
            providers: { [DEPLOY_ITEMS_PROVIDER]: items }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleTarget(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId),
        move: deployMove,
        copy: deployCopy
    },
    quotas: { targets: { list: (repo, owned) => repo.listStockTargets(owned) } },
    accountExport: deployAccountExport
};

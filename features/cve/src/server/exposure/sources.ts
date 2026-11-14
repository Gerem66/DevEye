import {
    DATABASE_ITEMS_PROVIDER,
    DEPLOY_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    type DatabaseHomeItem,
    type DatabaseItemsProvider,
    type DeployHomeTarget,
    type DeployItemsProvider,
    type GitHomeRepo,
    type GitItemsProvider
} from '@deveye/types/sdk';
import type { FeatureServiceDeps, SdkDevice } from '@deveye/types/sdk/server';

import type { AssetFormat, ExposureComponent, ExposureSource } from '../../contracts/exposure';
import { inventoryOfFiles, wantsRepoFile } from '../inventory/repoFiles';
import { databaseComponent, deviceComponents, imageComponent } from '../inventory/sources';
import { findTools, TOOLS } from '../inventory/tools';
import type { CveRepo } from '../repo';
import type { AssetRow } from './repo';

/**
 * Les sources de la veille : ce qu'une feature donne à lire, quand un de ses
 * éléments est dû, et comment le lire. La mécanique commune (rapprocher les
 * éléments suivis, servir les dus, écrire le résultat) est dans `engine.ts`.
 */

/** Un élément tel que sa source le liste. */
export interface SourceItem {
    ref: string;
    workspaceId: number;
    /** Tenu en pause par l'offre chez sa feature : la veille le laisse aussi. */
    paused: boolean;
}

export type ReadOutcome =
    | { kind: 'gone' }
    | { kind: 'unchanged'; revision: string | null }
    | { kind: 'error'; error: string; userSide: boolean }
    | {
          kind: 'scan';
          revision: string | null;
          digest: string | null;
          label: string;
          components: ExposureComponent[];
          formats: AssetFormat[];
          notes: string[];
      };

export interface Source<I extends SourceItem = SourceItem> {
    id: ExposureSource;
    /** Combien de lectures un passage s'accorde : ce que coûte la source au dehors. */
    readsPerPass: number;
    /** `null` : la feature n'est pas là, la veille ne touche à rien de ce qu'elle en suit. */
    list(workspaceIds: readonly number[]): Promise<readonly I[] | null>;
    /** Dû pour sa propre raison (une tête qui bouge), en plus de la règle commune. */
    isDue(asset: AssetRow, item: I, now: number): boolean;
    read(asset: AssetRow, item: I): Promise<ReadOutcome>;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Un dépôt dont Git ne connaît pas la tête (public, sans jeton) se relit une fois par jour. */
const UNSYNCED_RECHECK_S = 24 * 3600;
/** Un appareil ou un déploiement ne dit pas quand il change : il se relit à ce rythme. */
const POLL_S = 6 * 3600;

/** Les formats d'une liste de composants, comptés : ce que l'inventaire montre d'un élément qui n'a pas de fichiers. */
export function formatsOf(components: readonly ExposureComponent[]): AssetFormat[] {
    const counts = new Map<string, AssetFormat>();
    for (const c of components) {
        const key = `${c.format}|${c.format === 'compose' ? c.path : ''}`;
        const entry = counts.get(key) ?? { format: c.format, path: c.format === 'compose' ? c.path : null, count: 0 };
        entry.count++;
        counts.set(key, entry);
    }
    return [...counts.values()];
}

function notesOf(truncated: boolean, skipped: readonly string[]): string[] {
    const notes: string[] = [];
    if (truncated) notes.push('Dépôt trop grand : une partie de ses fichiers n’a pas été lue.');
    if (skipped.length > 0) {
        const shown = skipped.slice(0, 3).join(', ');
        const more = skipped.length > 3 ? ` et ${skipped.length - 3} autres` : '';
        notes.push(`Trop lourds pour être lus : ${shown}${more}.`);
    }
    return notes;
}

type GitItem = SourceItem & { home: GitHomeRepo };

export function gitSource(deps: FeatureServiceDeps<CveRepo>): Source<GitItem> {
    const git = (): GitItemsProvider | undefined => deps.providers.get<GitItemsProvider>(GIT_ITEMS_PROVIDER);
    return {
        id: 'git',
        readsPerPass: 6,
        async list(workspaceIds) {
            const provider = git();
            if (!provider) return null;
            return (await provider.listHome(workspaceIds)).map((home) => ({
                ref: String(home.id),
                workspaceId: home.workspaceId,
                paused: home.paused,
                home
            }));
        },
        isDue(asset, { home }, now) {
            if (home.headSha !== null) return asset.revision !== home.headSha;
            return (asset.checked_at ?? 0) < now - UNSYNCED_RECHECK_S;
        },
        async read(asset, { home }) {
            const provider = git();
            if (!provider) return { kind: 'gone' };
            const repoId = Number(asset.ref);
            const result = await provider.readFiles(repoId, asset.workspace_id, {
                ref: home.headSha,
                // Une relecture demandée relit tout, même un arbre inchangé :
                // c'est le geste qui suit une mise à jour des lecteurs.
                knownTree: asset.refresh_asked === 1 ? null : asset.digest,
                wants: wantsRepoFile,
                maxFiles: MAX_FILES,
                maxFileBytes: MAX_FILE_BYTES
            });
            if (result === null) return { kind: 'gone' };
            if (result.status === 'unchanged') return { kind: 'unchanged', revision: home.headSha };
            if (result.status === 'error') return { kind: 'error', error: result.error, userSide: result.userSide };
            const inventory = inventoryOfFiles(result.files);
            return {
                kind: 'scan',
                revision: home.headSha,
                digest: result.tree,
                label: (await provider.describe(repoId, asset.workspace_id))?.label ?? `Dépôt ${repoId}`,
                components: inventory.components,
                formats: inventory.formats,
                notes: notesOf(result.truncated, result.skipped)
            };
        }
    };
}

type DeviceItem = SourceItem & { device: SdkDevice };

/** Ce que le rapport d'un appareil dit de son système : ce qui, en changeant, le rend dû. */
export function osRevision(device: Pick<SdkDevice, 'report'>): string | null {
    const os = device.report?.os;
    return os ? `${os.name} ${os.version}` : null;
}

export function deviceSource(deps: FeatureServiceDeps<CveRepo>): Source<DeviceItem> {
    return {
        id: 'device',
        readsPerPass: 6,
        async list(workspaceIds) {
            const items: DeviceItem[] = [];
            for (const ws of workspaceIds) {
                for (const device of await deps.devicesFor(ws).list()) {
                    if (device.status !== 'active') continue;
                    items.push({ ref: device.id, workspaceId: ws, paused: false, device });
                }
            }
            return items;
        },
        isDue(asset, { device }, now) {
            return asset.revision !== osRevision(device) || (asset.checked_at ?? 0) < now - POLL_S;
        },
        async read(asset, { device }) {
            const online = deps.devicesFor(asset.workspace_id).isOnline(device.id);
            // Hors ligne, un appareil déjà lu garde son inventaire : il n'a rien dit de neuf.
            if (!online && asset.scanned_at !== null) return { kind: 'unchanged', revision: asset.revision };
            const inventory = online ? await deps.agents.dockerInventory(device.id) : null;
            const components = deviceComponents({
                os: device.report?.os ?? null,
                engines: (inventory?.engines ?? []).filter((e) => e.reachable),
                containers: (inventory?.containers ?? []).map((c) => ({
                    name: c.name,
                    image: c.image,
                    composeProject: c.composeProject,
                    composeService: c.composeService
                }))
            });
            const notes = !online
                ? ['Agent hors ligne : ses conteneurs se liront à son retour.']
                : inventory === null
                  ? [
                        'Les conteneurs n’ont pas pu être lus : Docker ne répond pas, ou la politique de l’agent le refuse.'
                    ]
                  : [];
            return {
                kind: 'scan',
                revision: osRevision(device),
                digest: null,
                label: device.name,
                components,
                formats: formatsOf(components),
                notes
            };
        }
    };
}

type DatabaseItem = SourceItem & { base: DatabaseHomeItem };

export function databaseSource(deps: FeatureServiceDeps<CveRepo>): Source<DatabaseItem> {
    const provider = (): DatabaseItemsProvider | undefined =>
        deps.providers.get<DatabaseItemsProvider>(DATABASE_ITEMS_PROVIDER);
    return {
        id: 'database',
        // Rien ne sort : la version est celle que Bases a déjà relevée.
        readsPerPass: Number.POSITIVE_INFINITY,
        async list(workspaceIds) {
            const databases = provider();
            if (!databases) return null;
            return (await databases.listHome(workspaceIds)).map((base) => ({
                ref: String(base.id),
                workspaceId: base.workspaceId,
                paused: base.paused,
                base
            }));
        },
        isDue(asset, { base }) {
            return asset.revision !== base.serverVersion;
        },
        async read(_asset, { base }) {
            const component = base.serverVersion ? databaseComponent(base.engine, base.serverVersion) : null;
            const components = component ? [component] : [];
            return {
                kind: 'scan',
                revision: base.serverVersion,
                digest: null,
                label: base.name,
                components,
                formats: formatsOf(components),
                notes:
                    base.serverVersion === null
                        ? [
                              'Aucun relevé de cette base : son relevé, ou une inspection, dira la version de son serveur.'
                          ]
                        : component === null
                          ? [`Version du serveur non reconnue : ${base.serverVersion.slice(0, 80)}.`]
                          : []
            };
        }
    };
}

type DeployItem = SourceItem & { target: DeployHomeTarget };

export function deploySource(deps: FeatureServiceDeps<CveRepo>): Source<DeployItem> {
    const provider = (): DeployItemsProvider | undefined =>
        deps.providers.get<DeployItemsProvider>(DEPLOY_ITEMS_PROVIDER);
    return {
        id: 'deploy',
        readsPerPass: 6,
        async list(workspaceIds) {
            const deploy = provider();
            if (!deploy) return null;
            // Une machine dit ses conteneurs, un workflow son dépôt : seul Dokploy
            // fait tourner ce qu'aucune autre source ne lit.
            return (await deploy.listHome(workspaceIds))
                .filter((target) => target.provider === 'dokploy')
                .map((target) => ({
                    ref: String(target.id),
                    workspaceId: target.workspaceId,
                    paused: target.paused,
                    target
                }));
        },
        isDue(asset, _item, now) {
            return (asset.checked_at ?? 0) < now - POLL_S;
        },
        async read(asset, { target }) {
            const deploy = provider();
            const answer = deploy ? await deploy.inventoryOf(target.id, asset.workspace_id) : null;
            if (answer === null) return { kind: 'gone' };
            if (answer.error !== null) {
                // L'instance Dokploy est celle du client : sa panne s'explique de son côté.
                return { kind: 'error', error: `Dokploy : ${answer.error}`, userSide: true };
            }
            const components: ExposureComponent[] = [];
            for (const image of answer.inventory?.images ?? []) {
                const component = imageComponent(image, 'deploy-image', null);
                if (component) components.push(component);
            }
            for (const file of answer.inventory?.composeFiles ?? []) {
                for (const t of findTools(file.path, file.text)) {
                    components.push({
                        kind: 'product',
                        ecosystem: t.tool,
                        name: TOOLS[t.tool].label,
                        version: t.version,
                        format: t.format,
                        path: t.path,
                        line: t.line
                    });
                }
            }
            return {
                kind: 'scan',
                revision: null,
                digest: null,
                label: target.name,
                components,
                formats: formatsOf(components),
                notes: []
            };
        }
    };
}

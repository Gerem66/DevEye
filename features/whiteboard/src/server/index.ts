import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WHITEBOARD_ITEMS_PROVIDER, type WhiteboardItemsProvider } from '@deveye/types/sdk';
import { mapLimit, type FeatureServer, type SdkObjectStore } from '@deveye/types/sdk/server';

import { KEY_CONTEXT, loadWhiteboardKeys, now, openTitle, setRuntime } from './_shared';
import { whiteboardAccountExport } from './accountExport';
import { whiteboardCopy } from './copy';
import { whiteboardE2e } from './e2e';
import { env, WHITEBOARD_ENV } from './env';
import { whiteboardHandlers } from './handlers';
import { whiteboardMove } from './move';
import { createRepo, type WhiteboardRepo } from './repo';
import { createSceneStore } from './scene';
import { Sessions } from './session/sessions';

/** Une image qu'aucun élément ne montre plus depuis ce temps est retirée. */
const ORPHAN_SECONDS = 86_400;
const SWEEP_EVERY_MS = 24 * 3_600_000;

async function storageProblemOf(objects: SdkObjectStore): Promise<string | null> {
    const ephemeral = await objects.ephemeralRoot();
    if (ephemeral !== null) {
        return `« ${ephemeral} » n’est sur aucun volume monté : les images des tableaux disparaîtraient au prochain redéploiement (WHITEBOARD_STORAGE_DIR).`;
    }
    try {
        await fs.mkdir(objects.spoolDir(), { recursive: true });
        const witness = `probe/${randomBytes(6).toString('hex')}`;
        await objects.put(witness, Buffer.from('deveye'));
        let readBack = 0;
        for await (const chunk of objects.get(witness)) readBack += chunk.length;
        await objects.delete(witness);
        return readBack === 6 ? null : 'le fichier témoin n’a pas été relu à l’identique.';
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * `items` : le partage, la copie et le déplacement des tableaux. Les tables ont
 * le préfixe `ft_whiteboard_` et leurs migrations ici.
 */
export const serverEntry: FeatureServer<WhiteboardRepo> = {
    env: WHITEBOARD_ENV,
    createRepo,
    features: whiteboardHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    quotas: {
        storage: { count: (repo, owned) => repo.boards.storedBytesIn(owned) }
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.boards.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        async labelOf(repo, cipher, itemId, workspaceId) {
            const row = await repo.boards.findVisible(Number(itemId), workspaceId);
            if (row === null) return null;
            return (await openTitle(cipher, row.content)) || 'Sans titre';
        },
        copy: whiteboardCopy,
        move: whiteboardMove
    },
    accountExport: whiteboardAccountExport,
    sealed: [{ table: 'ft_whiteboard_key', column: 'sealed', id: 'id', context: () => KEY_CONTEXT }],
    e2e: whiteboardE2e,
    async adminFacts({ repo }) {
        const totals = await repo.files.totals();
        return [
            { label: 'Tableaux', value: totals.boards, unit: 'count' },
            { label: 'Images stockées', value: totals.imageBytes, unit: 'bytes' }
        ];
    },
    createService(deps) {
        const objects = deps.objects(env.WHITEBOARD_STORAGE_DIR);
        const live = new Sessions({
            store: createSceneStore({ repo: deps.repo, cipherFor: deps.cipherFor, quotaFor: deps.quotaFor }),
            publishTo: (workspaceId, userIds, event, payload) =>
                deps.live.publishTo(workspaceId, userIds, event, payload),
            changed: (workspaceId) => deps.live.changed(workspaceId),
            logger: deps.logger
        });

        let problem: string | null = null;
        async function probeStorage(): Promise<string | null> {
            const found = await storageProblemOf(objects);
            if (found !== null && found !== problem) {
                deps.logger.error(
                    { dir: env.WHITEBOARD_STORAGE_DIR, problem: found },
                    'whiteboard: stockage des images inutilisable'
                );
            }
            problem = found;
            return found;
        }

        /** Les objets sans ligne ne partent qu'au second passage : une copie en cours a pu les écrire avant sa ligne. */
        let unclaimed = new Set<string>();
        async function sweep(): Promise<void> {
            for (const row of await deps.repo.files.orphanedBefore(now() - ORPHAN_SECONDS, 500)) {
                await deps.repo.files.deleteRow(row.id);
                await objects.delete(row.object_key).catch(() => undefined);
            }
            const stored: string[] = [];
            for await (const object of objects.list('img/')) stored.push(object.key);
            const known = new Set(await deps.repo.files.allObjectKeys());
            const strays = stored.filter((key) => !known.has(key));
            const gone = strays.filter((key) => unclaimed.has(key));
            unclaimed = new Set(strays.filter((key) => !unclaimed.has(key)));
            await mapLimit(gone, 8, (key) => objects.delete(key));
            if (gone.length > 0) deps.logger.info({ count: gone.length }, 'whiteboard: images sans tableau retirées');
        }

        let lastSweep = 0;
        const ticker = deps.createTicker({
            intervalMs: 1_000,
            async tick() {
                await live.tick();
                if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
                lastSweep = Date.now();
                await sweep().catch((error: unknown) =>
                    deps.logger.warn({ err: error }, 'whiteboard: ménage interrompu')
                );
            }
        });

        // Projets ne stocke que des identifiants : `exists` refuse de relier un
        // tableau invisible d'ici, et `labelOf` le nomme sous le codec de son
        // espace d'origine, seul à savoir l'ouvrir.
        const items: WhiteboardItemsProvider = {
            exists: async (boardId, workspaceId) => (await deps.repo.boards.findVisible(boardId, workspaceId)) !== null,
            labelOf: async (boardId, workspaceId) => {
                const row = await deps.repo.boards.findVisible(boardId, workspaceId);
                if (row === null) return null;
                return (await openTitle(deps.cipherFor(row.workspace_id), row.content)) || 'Sans titre';
            }
        };

        return {
            async start() {
                const keys = await loadWhiteboardKeys(deps.repo, deps.keys);
                await probeStorage();
                setRuntime({
                    objects,
                    keys,
                    sessions: live,
                    cipherFor: deps.cipherFor,
                    quotaFor: deps.quotaFor,
                    storageProblem: async () => (problem === null ? null : probeStorage())
                });
                await ticker.start();
            },
            async stop() {
                await ticker.stop();
                await live.stop();
                setRuntime(null);
            },
            providers: { [WHITEBOARD_ITEMS_PROVIDER]: items }
        };
    }
};

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { env } from './env';
import type { ConvertRepo } from './repo';
import { createService } from './service';
import { jobPaths } from './storage';
import { memoryRepo, type MemoryRepo } from './testing';

/**
 * L'arrêt et le redémarrage du service sur le même objet : un arrêt ne prend
 * plus de travail, rend à la file celui qu'il interrompt avec son fichier, et
 * le redémarrage reprend la file.
 */

let root: string;

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-service-'));
    env.CONVERT_STORAGE_DIR = root;
    env.CONVERT_DISK_FLOOR_BYTES = 1;
});
after(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

/** Un travail en file, son entrée sur le disque. */
async function queued(repo: MemoryRepo): Promise<number> {
    const id = await repo.insert({
        workspaceId: 1,
        userId: 1,
        kind: 'audio',
        sourceFormat: 'wav',
        targetFormat: 'mp3',
        options: { bitrate: 64 },
        originalNameEnc: 'note.wav',
        declaredBytes: 44,
        at: Math.floor(Date.now() / 1000)
    });
    const paths = jobPaths(1, id);
    await fs.mkdir(paths.work, { recursive: true });
    await fs.writeFile(paths.input, Buffer.alloc(44));
    Object.assign(repo.rows.find((r) => r.id === id) ?? {}, { phase: 'queued', input_bytes: 44 });
    return id;
}

function serviceWith(repo: MemoryRepo) {
    const deps = createTestServiceDeps<ConvertRepo>({ repo });
    const service = createService(deps, { fx: () => Promise.reject(new Error('hors ligne')) });
    return { deps, service, tick: () => deps.recorded.tickers[0].tick() };
}

describe('arrêt et redémarrage', () => {
    it('arrêté, le service ne prend plus rien ; redémarré, il reprend la file', async () => {
        const repo = memoryRepo();
        const id = await queued(repo);
        const { service, tick } = serviceWith(repo);
        await service.start();
        await service.stop();

        await tick();
        const row = repo.rows.find((r) => r.id === id);
        assert.deepEqual([row?.phase, row?.attempts], ['queued', 0]);

        await service.start();
        await tick();
        assert.notEqual(row?.phase, 'queued');
        assert.equal(row?.attempts, 1);
        await service.stop();
        await service.stop();
    });

    it('un arrêt en plein travail le rend à la file sans lui compter d’essai, et garde son fichier', async () => {
        const repo = memoryRepo();
        const id = await queued(repo);
        const { deps, service, tick } = serviceWith(repo);
        await service.start();

        // L'arrêt tombe au moment exact où le travail démarre.
        let stopping: void | Promise<void> = undefined;
        const changed = deps.live.changed;
        deps.live = {
            ...deps.live,
            changed: (workspaceId, topics) => {
                if (!stopping && repo.rows.find((r) => r.id === id)?.phase === 'running') stopping = service.stop();
                changed(workspaceId, topics);
            }
        };
        await tick();
        assert.ok(stopping, 'le travail a démarré');
        await stopping;

        const row = repo.rows.find((r) => r.id === id);
        assert.deepEqual([row?.phase, row?.attempts, row?.error_code], ['queued', 0, null]);
        await fs.access(jobPaths(1, id).input);
    });
});

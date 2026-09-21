import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { env } from './env';
import { ensureJobDir, jobPaths, probeStorage, removeJobDir, sweepStorage } from './storage';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

let root: string;
before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-storage-'));
    env.CONVERT_STORAGE_DIR = root;
});
after(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('stockage', () => {
    it('ne compose un chemin qu’avec des entiers', () => {
        assert.equal(jobPaths(3, 12).input, path.join(root, 'ws-3', '12', 'in.bin'));
        for (const bad of [0, -1, 1.5, Number.NaN]) {
            assert.throws(() => jobPaths(bad, 1));
            assert.throws(() => jobPaths(1, bad));
        }
    });

    it('retire les dossiers qu’aucun travail vivant ne réclame, et eux seuls', async () => {
        await ensureJobDir(jobPaths(1, 10));
        await ensureJobDir(jobPaths(1, 11));
        await ensureJobDir(jobPaths(2, 20));
        const removed = await sweepStorage(new Set(['1/10']), logger);
        assert.equal(removed, 2);
        assert.deepEqual(await fs.readdir(path.join(root, 'ws-1')), ['10']);
        await assert.rejects(fs.stat(path.join(root, 'ws-2')), 'un espace vidé ne laisse pas de dossier');
    });

    it('retire un dossier déjà parti sans s’en plaindre', async () => {
        await removeJobDir(9, 99);
        await removeJobDir(9, 99);
    });

    it('nomme la variable à régler quand la racine ne s’écrit pas', async () => {
        assert.equal(await probeStorage(), null);
        // Sous un fichier ordinaire : aucun dossier ne peut y naître.
        const blocker = path.join(root, 'fichier');
        await fs.writeFile(blocker, '');
        env.CONVERT_STORAGE_DIR = path.join(blocker, 'sous');
        try {
            assert.match((await probeStorage()) ?? '', /CONVERT_STORAGE_DIR/);
        } finally {
            env.CONVERT_STORAGE_DIR = root;
        }
    });
});

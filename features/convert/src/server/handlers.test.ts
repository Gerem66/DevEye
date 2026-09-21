import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, type TestContextOverrides } from '@deveye/types/sdk/testing';

import { convertCancel, convertCreate, convertDownload, convertList, convertRemove } from '../contracts/commands';
import { probeEngines } from './engines';
import { env } from './env';
import { convertHandlers } from './handlers';
import type { ConvertRepo } from './repo';
import { memoryRepo } from './testing';

/**
 * Ce que les commandes tiennent et qu'aucun typage ne garde : une conversion
 * n'existe que pour son auteur, une offre borne la taille d'un fichier, et rien
 * ne se retire pendant que ça tourne.
 */

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = convertHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<ConvertRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const IMAGE = {
    kind: 'image' as const,
    sourceFormat: 'png',
    targetFormat: 'jpg',
    options: { quality: 60 },
    originalName: 'contrat confidentiel.png',
    declaredBytes: 2_000_000
};

let root: string;
before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-handlers-'));
    env.CONVERT_STORAGE_DIR = root;
    env.CONVERT_DISK_FLOOR_BYTES = 1;
    // Les outils réellement présents sur le poste décident de ce que ce serveur sert : PNG et JPEG le sont partout.
    await probeEngines(null, { debug() {}, info() {}, warn() {}, error() {} });
});
after(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

const context = (repo: ConvertRepo, over: TestContextOverrides<ConvertRepo> = {}) =>
    createTestContext({ repo, ...over });

describe('convert.create', () => {
    it('ouvre un travail, scelle le nom, et rend une adresse de montée à ticket', async (t) => {
        const repo = memoryRepo();
        const ctx = context(repo);
        let out;
        try {
            out = await handlerFor(convertCreate)(ctx, IMAGE);
        } catch (e) {
            if (e instanceof FeatureError && e.code === 'conflict') return t.skip('ImageMagick absent de ce poste');
            throw e;
        }
        assert.equal(out.job.phase, 'awaiting_upload');
        assert.equal(out.job.originalName, IMAGE.originalName);
        assert.match(out.uploadUrl, /^\/api\/convert\/upload\?token=/);
        assert.equal(out.job.options.stripMetadata, true, 'les défauts complètent ce qui manque');
        assert.equal(ctx.recorded.audits.length, 1);
        assert.doesNotMatch(JSON.stringify(ctx.recorded.audits), /confidentiel/, 'le nom ne va jamais au journal');
    });

    it('refuse une paire qui n’existe pas', async () => {
        await assert.rejects(
            handlerFor(convertCreate)(context(memoryRepo()), {
                ...IMAGE,
                kind: 'document',
                sourceFormat: 'xlsx',
                targetFormat: 'docx'
            }),
            (e: unknown) => e instanceof FeatureError && e.code === 'validation'
        );
    });

    it('refuse au-delà du mur du serveur, puis au-delà de l’offre', async (t) => {
        await assert.rejects(
            handlerFor(convertCreate)(context(memoryRepo()), {
                ...IMAGE,
                declaredBytes: env.CONVERT_MAX_FILE_BYTES + 1
            }),
            (e: unknown) => e instanceof FeatureError && e.code === 'validation' && /trop lourd/.test(e.message)
        );
        try {
            await handlerFor(convertCreate)(context(memoryRepo(), { quotaLimits: { fileBytes: 1_000_000 } }), IMAGE);
            assert.fail('l’offre devait refuser');
        } catch (e) {
            if (e instanceof FeatureError && e.code === 'conflict') return t.skip('ImageMagick absent de ce poste');
            assert.ok(e instanceof FeatureError && e.code === 'quota_exceeded');
        }
    });
});

describe('visibilité et cycle de vie', () => {
    async function seeded() {
        const repo = memoryRepo();
        const id = await repo.insert({
            workspaceId: 1,
            userId: 1,
            kind: 'image',
            sourceFormat: 'png',
            targetFormat: 'jpg',
            options: {},
            originalNameEnc: 'a.png',
            declaredBytes: 10,
            at: 100
        });
        return { repo, id };
    }

    it('ne montre à un membre que ses propres conversions', async () => {
        const { repo, id } = await seeded();
        assert.equal((await handlerFor(convertList)(context(repo), {})).jobs.length, 1);
        const other = context(repo, { userId: 2 });
        assert.equal((await handlerFor(convertList)(other, {})).jobs.length, 0);
        await assert.rejects(
            handlerFor(convertCancel)(other, { jobId: id }),
            (e: unknown) => e instanceof FeatureError && e.code === 'not_found'
        );
    });

    it('ne rend un résultat que fini, et pas encore échu', async () => {
        const { repo, id } = await seeded();
        const download = handlerFor(convertDownload);
        await assert.rejects(download(context(repo), { jobId: id }), (e: unknown) => e instanceof FeatureError);
        Object.assign(repo.rows[0], { phase: 'done', expires_at: Math.floor(Date.now() / 1000) + 600 });
        assert.match((await download(context(repo), { jobId: id })).url, /^\/api\/convert\/result\?token=/);
        repo.rows[0].expires_at = 1;
        await assert.rejects(download(context(repo), { jobId: id }), (e: unknown) => e instanceof FeatureError);
    });

    it('refuse de retirer un travail en cours, l’accepte une fois annulé', async () => {
        const { repo, id } = await seeded();
        repo.rows[0].phase = 'running';
        await assert.rejects(
            handlerFor(convertRemove)(context(repo), { jobId: id }),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict'
        );
        assert.equal((await handlerFor(convertCancel)(context(repo), { jobId: id })).job.phase, 'canceled');
        assert.deepEqual(await handlerFor(convertRemove)(context(repo), { jobId: id }), { removed: true });
    });
});

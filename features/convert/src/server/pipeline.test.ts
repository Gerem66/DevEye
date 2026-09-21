import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type {
    SdkPublicHandler,
    SdkPublicReply,
    SdkPublicStreamHandler,
    SdkPublicStreamRequest
} from '@deveye/types/sdk/server';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { CONVERT_PROGRESS_EVENT } from '../contracts/domain';
import { engineFamilies } from './engines';
import { env } from './env';
import type { ConvertRepo } from './repo';
import { DOWNLOAD_PATH, UPLOAD_PATH } from './routes';
import { createService } from './service';
import { jobPaths } from './storage';
import { memoryRepo, type MemoryRepo } from './testing';

/**
 * La chaîne entière, sur le harnais : la montée par la route en flux, la file,
 * une vraie conversion, la descente du résultat. Les cas qui demandent ffmpeg se
 * passent quand il est absent du poste ; les gardes de la route, eux, tournent
 * partout.
 */

/** Une seconde de silence, mono, 8 kHz : le plus petit WAV qu'un outil accepte. */
function wav(seconds = 1): Buffer {
    const data = Buffer.alloc(8000 * 2 * seconds);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

function fakeReply() {
    const state = { status: 200, headers: {} as Record<string, string>, payload: undefined as unknown };
    const reply: SdkPublicReply = {
        header: (name, value) => ((state.headers[name] = value), reply),
        code: (status) => ((state.status = status), reply),
        send: (payload) => (state.payload = payload)
    };
    return { reply, state };
}

const ticket = (jobId: number, purpose: 'upload' | 'download', userId = 1): string =>
    `ticket:${JSON.stringify({ userId, workspaceId: 1, payload: { jobId, purpose }, unlocked: true })}`;

function uploadRequest(
    token: string,
    body: Buffer,
    contentLength: number | null = body.length
): SdkPublicStreamRequest {
    return {
        headers: {},
        query: { token },
        ip: '127.0.0.1',
        body: {
            contentLength,
            bytes: async function* () {
                for (let at = 0; at < body.length; at += 4096) yield body.subarray(at, at + 4096);
            }
        }
    };
}

async function seed(repo: MemoryRepo, sourceFormat: string, targetFormat: string): Promise<number> {
    return repo.insert({
        workspaceId: 1,
        userId: 1,
        kind: 'audio',
        sourceFormat,
        targetFormat,
        options: { bitrate: 64 },
        originalNameEnc: 'mémo vocal.wav',
        declaredBytes: 16_044,
        at: Math.floor(Date.now() / 1000)
    });
}

let root: string;
let upload: SdkPublicStreamHandler;
let download: SdkPublicHandler;
let repo: MemoryRepo;
let deps: ReturnType<typeof createTestServiceDeps<ConvertRepo>>;
let stop: () => void | Promise<void>;

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-pipeline-'));
    env.CONVERT_STORAGE_DIR = root;
    env.CONVERT_DISK_FLOOR_BYTES = 1;
    repo = memoryRepo();
    deps = createTestServiceDeps<ConvertRepo>({ repo });
    const service = createService(deps, { fx: () => Promise.reject(new Error('hors ligne')) });
    service.publicRoutes?.({
        get: (route, _opts, handler) => void (route === DOWNLOAD_PATH && (download = handler)),
        post: () => assert.fail('aucun POST décodé attendu'),
        postStream: (route, opts, handler) => {
            assert.equal(route, UPLOAD_PATH);
            assert.equal(opts.exposure, 'app');
            assert.equal(opts.maxBytes, env.CONVERT_MAX_FILE_BYTES);
            upload = handler;
        }
    });
    await service.start();
    stop = () => service.stop();
});
after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
});

const hasFfmpeg = (): boolean => engineFamilies().some((f) => f.kind === 'audio' && f.available);

describe('route de montée', () => {
    it('refuse sans ticket, avec un ticket de descente, ou pour le travail d’un autre', async () => {
        const id = await seed(repo, 'wav', 'mp3');
        for (const token of ['', 'faux', ticket(id, 'download')]) {
            const { reply, state } = fakeReply();
            await upload(uploadRequest(token, wav()), reply);
            assert.equal(state.status, 401);
        }
        const { reply, state } = fakeReply();
        await upload(uploadRequest(ticket(id, 'upload', 2), wav()), reply);
        assert.equal(state.status, 409, 'le ticket d’un autre membre ne monte rien');
    });

    it('refuse un fichier plus lourd que l’offre, annoncé ou non', async () => {
        const limited = createTestServiceDeps<ConvertRepo>({ repo, quotaLimits: { fileBytes: 1000 } });
        let limitedUpload: SdkPublicStreamHandler | null = null;
        createService(limited).publicRoutes?.({
            get: () => undefined,
            post: () => undefined,
            postStream: (_route, _opts, handler) => (limitedUpload = handler)
        });
        assert.ok(limitedUpload);
        for (const announced of [16_044, null]) {
            const id = await seed(repo, 'wav', 'mp3');
            const { reply, state } = fakeReply();
            await (limitedUpload as SdkPublicStreamHandler)(
                uploadRequest(ticket(id, 'upload'), wav(), announced),
                reply
            );
            assert.equal(state.status, 413);
            assert.equal(repo.rows.find((r) => r.id === id)?.error_code, 'too_large');
            await assert.rejects(fs.stat(jobPaths(1, id).dir), 'rien ne reste sur le disque');
        }
    });

    it('refuse un fichier qui n’est pas ce qu’il annonce', async (t) => {
        if (!hasFfmpeg()) return t.skip('ffmpeg absent de ce poste');
        const id = await seed(repo, 'mp3', 'wav');
        const { reply, state } = fakeReply();
        await upload(uploadRequest(ticket(id, 'upload'), wav()), reply);
        assert.equal(state.status, 422);
        assert.equal(repo.rows.find((r) => r.id === id)?.error_code, 'format_mismatch');
    });
});

describe('de la montée au résultat', () => {
    it('convertit un vrai fichier, pousse l’avancement, et ne sert le résultat qu’à son auteur', async (t) => {
        if (!hasFfmpeg()) return t.skip('ffmpeg absent de ce poste');
        const id = await seed(repo, 'wav', 'mp3');
        const sent = fakeReply();
        await upload(uploadRequest(ticket(id, 'upload'), wav(3)), sent.reply);
        assert.deepEqual(sent.state.payload, { ok: true });

        const replay = fakeReply();
        await upload(uploadRequest(ticket(id, 'upload'), wav(3)), replay.reply);
        assert.equal(replay.state.status, 409, 'un ticket rejoué ne remonte pas le fichier');

        // La route a déjà réveillé la file : la conversion tourne, il reste à l'attendre.
        const row = repo.rows.find((r) => r.id === id);
        for (let waited = 0; waited < 300 && (row?.phase === 'queued' || row?.phase === 'running'); waited++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(row?.phase, 'done', row?.error_enc ?? '');
        assert.ok(Number(row?.output_bytes) > 0);
        const paths = jobPaths(1, id);
        assert.deepEqual(
            (await fs.readdir(paths.dir)).sort(),
            ['out.bin'],
            'l’entrée et le dossier de travail sont partis'
        );
        assert.ok(deps.recorded.livePublishes.every((p) => p.event === CONVERT_PROGRESS_EVENT));

        const stranger = fakeReply();
        await download(
            { headers: {}, body: undefined, query: { token: ticket(id, 'download', 2) }, ip: '::1' },
            stranger.reply
        );
        assert.equal(stranger.state.status, 404);

        const mine = fakeReply();
        await download(
            { headers: {}, body: undefined, query: { token: ticket(id, 'download') }, ip: '::1' },
            mine.reply
        );
        assert.equal(mine.state.headers['Content-Type'], 'audio/mpeg');
        assert.match(
            mine.state.headers['Content-Disposition'],
            /^attachment; filename="m_mo vocal\.mp3"; filename\*=UTF-8''m%C3%A9mo%20vocal\.mp3$/
        );
        assert.equal(mine.state.headers['Content-Length'], String(row?.output_bytes));
    });

    it('retire du disque un résultat échu', async (t) => {
        if (!hasFfmpeg()) return t.skip('ffmpeg absent de ce poste');
        const done = repo.rows.find((r) => r.phase === 'done');
        assert.ok(done);
        done.expires_at = 1;
        await deps.recorded.tickers[1].tick();
        assert.equal(done.phase, 'expired');
        await assert.rejects(fs.stat(jobPaths(1, done.id).dir));
    });
});

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';

import Fastify, { type FastifyBaseLogger } from 'fastify';
import pino from 'pino';

import { QuietFilesLogController } from './app';

interface Line {
    msg: string;
    req?: { url: string };
    res?: { statusCode: number };
}

async function requestLogs(url: string): Promise<Line[]> {
    const lines: Line[] = [];
    const sink = new Writable({
        write(chunk: Buffer, _enc, done) {
            lines.push(JSON.parse(chunk.toString()) as Line);
            done();
        }
    });
    const app = Fastify({
        loggerInstance: pino(sink) as FastifyBaseLogger,
        logController: new QuietFilesLogController()
    });
    app.get('/assets/app.js', async () => 'ok');
    app.get('/api/status', async () => ({ ok: true }));
    app.get('/projects', async () => 'page');
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
    await app.inject({ method: 'GET', url });
    await app.close();
    return lines;
}

describe('QuietFilesLogController', () => {
    it('tait un fichier servi', async () => {
        assert.deepEqual(await requestLogs('/assets/app.js?v=1'), []);
    });

    it('journalise un fichier absent en une ligne qui le nomme', async () => {
        const lines = await requestLogs('/assets/old-chunk.js');
        assert.equal(lines.length, 1);
        assert.equal(lines[0].msg, 'request completed');
        assert.equal(lines[0].req?.url, '/assets/old-chunk.js');
        assert.equal(lines[0].res?.statusCode, 404);
    });

    it('garde les deux lignes d’une page et d’un appel à l’API', async () => {
        for (const url of ['/projects', '/api/status']) {
            const lines = await requestLogs(url);
            assert.deepEqual(
                lines.map((l) => l.msg),
                ['incoming request', 'request completed']
            );
        }
    });
});

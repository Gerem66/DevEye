import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { FeatureError } from '@deveye/types/sdk/server';
import type { FastifyRequest } from 'fastify';

import { streamRequest } from './register';

/**
 * Le corps d'une route en flux : ce que l'hôte garantit à la place du module,
 * le plafond d'octets et la coupure de la connexion quand il est franchi.
 */

function fakeRequest(body: Readable, headers: Record<string, string> = {}): FastifyRequest {
    return { body, headers, query: { token: 't' }, params: {}, host: 'deveye.test', ip: '127.0.0.1' } as FastifyRequest;
}

async function drain(source: AsyncIterable<Buffer>): Promise<number> {
    let total = 0;
    for await (const chunk of source) total += chunk.length;
    return total;
}

describe('streamRequest', () => {
    it('rend les octets dans l’ordre, sous le plafond', async () => {
        const req = streamRequest(fakeRequest(Readable.from([Buffer.alloc(3), Buffer.alloc(4)])), 7);
        assert.equal(await drain(req.body.bytes()), 7);
    });

    it('lit la taille annoncée, et rend null quand elle manque', () => {
        const announced = streamRequest(fakeRequest(Readable.from([]), { 'content-length': '42' }), 100);
        assert.equal(announced.body.contentLength, 42);
        assert.equal(streamRequest(fakeRequest(Readable.from([])), 100).body.contentLength, null);
    });

    it('lève et détruit le flux au-delà du plafond', async () => {
        const raw = Readable.from([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]);
        const req = streamRequest(fakeRequest(raw), 6);
        await assert.rejects(
            drain(req.body.bytes()),
            (e: unknown) => e instanceof FeatureError && e.code === 'validation'
        );
        assert.equal(raw.destroyed, true);
    });

    it('ne porte ni corps décodé ni session', () => {
        const req = streamRequest(fakeRequest(Readable.from([])), 1);
        assert.deepEqual(req.query, { token: 't' });
        assert.equal(req.ip, '127.0.0.1');
    });
});

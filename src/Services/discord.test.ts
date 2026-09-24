import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Logger } from 'pino';
import { Response } from 'undici';

import { editMessage, postMessage } from './discord';
import { setSafeFetchTransportForTest } from './netFetch';

const HOOK = 'https://discord.com/api/webhooks/1/token';
const logger = { warn: () => undefined } as unknown as Logger;

afterEach(() => setSafeFetchTransportForTest(null));

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('discord : débit', () => {
    it('reprend une fois après le délai court que demande un 429', async () => {
        const calls: string[] = [];
        setSafeFetchTransportForTest(async (url) => {
            calls.push(url);
            return calls.length === 1
                ? json(429, { retry_after: 0.01 }, { 'retry-after': '0.01' })
                : json(200, { id: 'm1' });
        });
        assert.equal(await postMessage(HOOK, { content: 'x' }, logger), 'm1');
        assert.equal(calls.length, 2);
    });

    it('rend le refus quand Discord demande trop longtemps', async () => {
        let calls = 0;
        setSafeFetchTransportForTest(async () => {
            calls += 1;
            return json(429, { retry_after: 60 }, { 'retry-after': '60' });
        });
        assert.equal(await editMessage(HOOK, 'm1', { content: 'x' }, logger), false);
        assert.equal(calls, 1);
    });

    it('fait passer les envois vers un même webhook l’un après l’autre', async () => {
        let open = 0;
        let peak = 0;
        setSafeFetchTransportForTest(async () => {
            open += 1;
            peak = Math.max(peak, open);
            await new Promise((resolve) => setTimeout(resolve, 5));
            open -= 1;
            return json(200, { id: 'm' });
        });
        await Promise.all([
            postMessage(HOOK, { content: 'a' }, logger),
            editMessage(HOOK, 'm', { content: 'b' }, logger),
            postMessage(`${HOOK}?thread_id=9`, { content: 'c' }, logger)
        ]);
        assert.equal(peak, 1);
    });
});

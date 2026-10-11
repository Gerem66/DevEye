import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { createOvhSms, ovhSignature } from './ovh';

const config = {
    endpoint: 'https://eu.api.ovh.com/1.0/',
    appKey: 'AK',
    appSecret: 'AS',
    consumerKey: 'CK',
    service: 'sms-ab12345-1'
};

describe('ovhSignature', () => {
    it('signe les six champs joints par « + », préfixés de $1$', () => {
        const expected = createHash('sha1')
            .update('AS+CK+POST+https://eu.api.ovh.com/1.0/sms/x/jobs+{"a":1}+1700000000')
            .digest('hex');
        assert.equal(
            ovhSignature('AS', 'CK', 'POST', 'https://eu.api.ovh.com/1.0/sms/x/jobs', '{"a":1}', 1700000000),
            `$1$${expected}`
        );
    });
});

describe('createOvhSms', () => {
    it('envoie à l’heure d’OVH, signé, sans « STOP », et refuse un numéro rejeté', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        let accept = true;
        const fake = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            if (String(url).endsWith('/auth/time')) return new Response('1700000000');
            return new Response(
                JSON.stringify(accept ? { validReceivers: ['+33612345678'] } : { invalidReceivers: ['+33612345678'] })
            );
        }) as typeof fetch;
        const sms = createOvhSms(config, fake);
        await sms.send('+33612345678', 'DevEye : votre code est 123456.');

        const job = calls.find((c) => c.url.endsWith('/sms/sms-ab12345-1/jobs'));
        assert.ok(job, 'le travail part au bon compte, sans double barre');
        const headers = job.init?.headers as Record<string, string>;
        const body = JSON.parse(String(job.init?.body)) as Record<string, unknown>;
        assert.equal(body.noStopClause, true);
        assert.equal(body.senderForResponse, true);
        assert.deepEqual(body.receivers, ['+33612345678']);
        const timestamp = Number(headers['X-Ovh-Timestamp']);
        assert.ok(Math.abs(timestamp - 1700000000) < 5, 'l’heure est celle d’OVH');
        assert.equal(
            headers['X-Ovh-Signature'],
            ovhSignature('AS', 'CK', 'POST', job.url, String(job.init?.body), timestamp)
        );

        accept = false;
        await assert.rejects(sms.send('+33612345678', 'x'), /refusé/);
        assert.equal(calls.filter((c) => c.url.endsWith('/auth/time')).length, 1, 'l’heure se relit rarement');
    });
});

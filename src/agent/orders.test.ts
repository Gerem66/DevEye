import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { describe, it } from 'node:test';

import { orderSignatureSchema } from '@deveye/types';

import { agentFrame, orderSigningPublicKey } from './orders';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKey() {
    const raw = Buffer.from(orderSigningPublicKey, 'base64');
    assert.equal(raw.length, 32);
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

describe('agentFrame', () => {
    it('signe un ordre à fort impact, sur les octets exacts du payload', () => {
        const payload = { sessionId: 's1', cols: 80, rows: 24, user: 'é"\\n' };
        const frame = agentFrame('term.open', payload, 1_700_000_000_000);
        const parsed = JSON.parse(frame) as { command: string; payload: unknown; sig: unknown };
        assert.deepEqual(parsed.payload, payload);
        const sig = orderSignatureSchema.parse(parsed.sig);
        assert.equal(sig.issuedAt, 1_700_000_000_000);

        // Ce que l'agent vérifie : le payload tel qu'il est écrit dans la trame.
        const payloadJson = JSON.stringify(payload);
        assert.ok(frame.includes(`"payload":${payloadJson}`));
        const message = Buffer.concat([
            Buffer.from(`term.open\n${sig.nonce}\n${sig.issuedAt}\n`),
            Buffer.from(payloadJson)
        ]);
        assert.ok(verify(null, message, publicKey(), Buffer.from(sig.signature, 'base64')));
        const tampered = Buffer.concat([
            Buffer.from(`term.open\n${sig.nonce}\n${sig.issuedAt}\n`),
            Buffer.from(payloadJson.replace('80', '81'))
        ]);
        assert.equal(verify(null, tampered, publicKey(), Buffer.from(sig.signature, 'base64')), false);
    });

    it('deux trames du même ordre ne portent pas le même nonce', () => {
        const a = JSON.parse(agentFrame('agent.power', { action: 'reboot' })) as { sig: { nonce: string } };
        const b = JSON.parse(agentFrame('agent.power', { action: 'reboot' })) as { sig: { nonce: string } };
        assert.notEqual(a.sig.nonce, b.sig.nonce);
    });

    it('ne signe pas un ordre ordinaire', () => {
        const frame = JSON.parse(agentFrame('agent.collect', {})) as Record<string, unknown>;
        assert.deepEqual(Object.keys(frame), ['command', 'payload']);
    });
});

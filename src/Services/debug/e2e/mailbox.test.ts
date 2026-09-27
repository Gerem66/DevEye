import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MailMessage, Mailer } from '@/Services/mailer';
import { createMailbox } from './mailbox';

function harness() {
    const delivered: MailMessage[] = [];
    const warnings: string[] = [];
    const inner: Mailer = {
        configured: true,
        send: async (m) => void delivered.push(m),
        verify: async () => undefined
    };
    const box = createMailbox({ warn: (_o: object, msg: string) => void warnings.push(msg) } as never);
    return { box, mailer: box.tap(inner), delivered, warnings };
}

const mail = (to: string, subject = 'Sujet'): MailMessage => ({ to, subject, text: 't', html: 'h' });

describe('la boîte des essais', () => {
    it('ne remet jamais au serveur SMTP un mail du domaine réservé, attendu ou non', async () => {
        const h = harness();
        h.box.expect('a@e2e.deveye.invalid');
        await h.mailer.send(mail('a@e2e.deveye.invalid'));
        await h.mailer.send(mail('b@e2e.deveye.invalid'));
        await h.mailer.send(mail('alice@exemple.fr'));
        assert.deepEqual(
            h.delivered.map((m) => m.to),
            ['alice@exemple.fr']
        );
        assert.equal(h.warnings.length, 1);
        assert.equal((await h.box.next('A@e2e.deveye.invalid', 10)).to, 'a@e2e.deveye.invalid');
    });

    it('rend le mail qui arrive après l’attente, et rejette passé le délai', async () => {
        const h = harness();
        h.box.expect('a@e2e.deveye.invalid');
        const waiting = h.box.next('a@e2e.deveye.invalid', 1000);
        await h.mailer.send(mail('a@e2e.deveye.invalid', 'Bienvenue'));
        assert.equal((await waiting).subject, 'Bienvenue');
        await assert.rejects(h.box.next('a@e2e.deveye.invalid', 20), /Aucun mail reçu/);
        h.box.forget('a@e2e.deveye.invalid');
        await assert.rejects(h.box.next('a@e2e.deveye.invalid', 20), /Aucun mail attendu/);
    });
});

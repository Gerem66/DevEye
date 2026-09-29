import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Mailer, MailMessage } from '../src/Services/mailer';
import { createAlerts } from './alerts';
import type { ComponentChange } from './monitor';
import { UNKNOWN, type ComponentState } from './state';
import { openStore } from './store';

function setup(live = true) {
    const store = openStore(':memory:');
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const mails: MailMessage[] = [];
    const mailer: Mailer = {
        configured: true,
        send: async (m) => {
            mails.push(m);
        },
        verify: async () => undefined
    };
    const alerts = createAlerts({
        store,
        live,
        origin: 'https://app.deveye.fr',
        mailer,
        fallbackEmail: 'ops@example.org',
        fetchChannels: async () => ({
            webhooks: [{ kind: 'discord', url: 'https://discord.com/api/webhooks/1/x' }],
            emails: ['admin@example.org']
        }),
        post: async (url, body) => {
            posts.push({ url, body });
            return true;
        },
        log: () => undefined,
        now: () => 1000
    });
    return { store, alerts, posts, mails };
}

function change(
    to: ComponentState,
    over: Partial<ComponentChange['next']> = {},
    kind: 'app' | 'feature' = 'app'
): ComponentChange {
    return {
        component: {
            id: kind === 'app' ? 'deveye' : 'notes',
            label: kind === 'app' ? 'Application DevEye' : 'Notes',
            kind
        },
        next: { ...UNKNOWN, state: to, since: 1000, ...over },
        transition: { from: null, to, at: 1000, inherited: over.inherited ?? false }
    };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('createAlerts', () => {
    it('une panne part sur le webhook et par e-mail, secours compris ; son retour aussi', async () => {
        const { alerts, posts, mails } = setup();
        await alerts.refreshChannels();
        alerts.onChange(change('down', { reason: 'Ne répond pas' }));
        await settle();
        assert.equal(posts.length, 1);
        assert.equal((posts[0]!.body.embeds as { title: string }[])[0]!.title, 'DevEye est hors service');
        assert.deepEqual(mails.map((m) => m.to).sort(), ['admin@example.org', 'ops@example.org']);
        alerts.onChange(change('up'));
        await settle();
        assert.equal(posts.length, 2);
        assert.equal(mails.at(-1)!.subject, '[DevEye] DevEye est rétabli');
    });

    it('jamais sur une maintenance, ni sur une panne héritée de l’app', async () => {
        const { alerts, posts } = setup();
        await alerts.refreshChannels();
        alerts.onChange(change('maintenance'));
        alerts.onChange(change('down', { inherited: true }, 'feature'));
        await settle();
        assert.equal(posts.length, 0);
    });

    it('hors production, rien ne part', async () => {
        const { alerts, posts, mails } = setup(false);
        await alerts.refreshChannels();
        alerts.onChange(change('down'));
        await settle();
        assert.equal(posts.length + mails.length, 0);
    });

    it('un DevEye injoignable ne fait pas oublier les destinations connues', async () => {
        const { alerts, store } = setup();
        await alerts.refreshChannels();
        const kept = store.meta('channels');
        const failing = createAlerts({
            store,
            live: true,
            origin: 'x',
            mailer: { configured: false, send: async () => undefined, verify: async () => undefined },
            fallbackEmail: null,
            fetchChannels: async () => {
                throw new Error('down');
            },
            post: async () => true,
            log: () => undefined
        });
        await failing.refreshChannels();
        assert.equal(store.meta('channels'), kept);
    });
});

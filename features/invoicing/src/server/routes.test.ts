import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkDomain, SdkPublicApp, SdkPublicReply, SdkPublicRequest } from '@deveye/types/sdk/server';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { todayIn } from '../contracts/calendar';
import { DEFAULT_SETTINGS } from '../contracts/defaults';
import { docRow, emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { createService } from './service';

const DAY = todayIn('Europe/Paris');

interface Answer {
    status: number;
    headers: Record<string, string>;
    body: string;
}

/** Une réponse qui note ce qu'on lui donne, comme le ferait l'hôte. */
function reply(): SdkPublicReply & { answer: Answer } {
    const answer: Answer = { status: 200, headers: {}, body: '' };
    const self: SdkPublicReply & { answer: Answer } = {
        answer,
        header(name, value) {
            answer.headers[name.toLowerCase()] = String(value);
            return self;
        },
        code(status) {
            answer.status = status;
            return self;
        },
        send(payload) {
            answer.body = typeof payload === 'string' ? payload : '';
            return answer;
        }
    };
    return self;
}

function mount(store: MemoryStore, domains: readonly SdkDomain[] = []) {
    const handlers = new Map<string, (req: SdkPublicRequest, res: SdkPublicReply) => Promise<unknown>>();
    const app: SdkPublicApp = {
        get: (path, _opts, handler) => handlers.set(`GET ${path}`, handler),
        post: (path, _opts, handler) => handlers.set(`POST ${path}`, handler),
        postStream: () => undefined
    };
    const deps = createTestServiceDeps({ repo: memoryRepo(store), domains });
    createService(deps).publicRoutes?.(app);
    return { handlers, deps };
}

function request(over: Partial<SdkPublicRequest> = {}): SdkPublicRequest {
    return { headers: {}, host: 'public.deveye.test', body: undefined, ip: '203.0.113.7', ...over };
}

function readySettings(store: MemoryStore): void {
    store.settings.set(1, {
        currency: 'EUR',
        time_zone: 'Europe/Paris',
        vat_regime: 'standard',
        default_vat_bp: 2000,
        payment_terms_days: 30,
        quote_validity_days: 30,
        quote_prefix: 'D',
        invoice_prefix: 'F',
        credit_prefix: 'A',
        number_reset: 'yearly',
        number_start: 1,
        number_pad: 4,
        mail_sender_id: null,
        domain_id: null,
        content: JSON.stringify({
            issuer: { ...DEFAULT_SETTINGS.issuer, legalName: 'Atelier Dupont', siret: '81234567800017' },
            wording: DEFAULT_SETTINGS.wording
        })
    });
}

describe('la page publique', () => {
    it('rend le document quand le jeton est bon', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(
            docRow({ id: 10, kind: 'quote', status: 'sent', public_token: 'jeton', number_label: 'D2026-0001' })
        );
        const { handlers } = mount(store);

        const res = reply();
        await handlers.get('GET /f/:token')!(request({ params: { token: 'jeton' } }), res);

        assert.equal(res.answer.status, 200);
        assert.ok(res.answer.body.includes('DEVIS'));
        assert.ok(res.answer.body.includes('D2026-0001'));
        assert.equal(res.answer.headers['x-robots-tag'], 'noindex, nofollow');
    });

    it('propose l’accord sur un devis en attente, et sans une ligne de script', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, kind: 'quote', status: 'sent', public_token: 'jeton' }));
        const { handlers } = mount(store);

        const res = reply();
        await handlers.get('GET /f/:token')!(request({ params: { token: 'jeton' } }), res);

        assert.ok(res.answer.body.includes('J’accepte ce devis'));
        assert.ok(res.answer.body.includes('Je refuse'));
        assert.ok(res.answer.body.includes('method="post"'));
        assert.ok(!/<script\b/i.test(res.answer.body), 'aucun script');
    });

    it('ne montre pas les deux voies à la fois : le formulaire à l’écran, le cadre au papier', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, kind: 'quote', status: 'sent', public_token: 'jeton' }));
        const { handlers } = mount(store);

        const res = reply();
        await handlers.get('GET /f/:token')!(request({ params: { token: 'jeton' } }), res);

        // Le cadre reste dans le document, pour qui imprime la page et signe à la
        // main ; il est seulement caché là où l'on peut cliquer.
        assert.ok(res.answer.body.includes('class="sign"'));
        assert.ok(res.answer.body.includes('@media screen { .sign { display: none; } }'));
        assert.ok(res.answer.body.includes('@media print { .accept { display: none; } }'));
    });

    it('ne montre ni formulaire ni cadre sur un devis déjà répondu', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, kind: 'quote', status: 'accepted', public_token: 'jeton' }));
        const { handlers } = mount(store);

        const res = reply();
        await handlers.get('GET /f/:token')!(request({ params: { token: 'jeton' } }), res);

        assert.ok(!res.answer.body.includes('class="accept"'));
        assert.ok(!res.answer.body.includes('class="sign"'));
    });

    it('ne propose rien sur une facture, ni sur un devis déjà accepté', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, public_token: 'facture' }));
        store.docs.push(docRow({ id: 11, kind: 'quote', status: 'accepted', public_token: 'accepte' }));
        const { handlers } = mount(store);

        for (const token of ['facture', 'accepte']) {
            const res = reply();
            await handlers.get('GET /f/:token')!(request({ params: { token } }), res);
            assert.ok(!res.answer.body.includes('J’accepte ce devis'), token);
        }
    });

    it('ne dit rien de plus qu’une page absente quand le jeton est inconnu', async () => {
        const store = emptyStore();
        const { handlers } = mount(store);

        const res = reply();
        await handlers.get('GET /f/:token')!(request({ params: { token: 'inconnu' } }), res);

        assert.equal(res.answer.status, 404);
        assert.ok(res.answer.body.includes('n’est plus accessible'));
        assert.ok(!res.answer.body.includes('Atelier'), 'rien ne fuit du document');
    });

    it('refuse un jeton vide', async () => {
        const store = emptyStore();
        const { handlers } = mount(store);
        const res = reply();
        await handlers.get('GET /f/:token')!(request({ params: {} }), res);
        assert.equal(res.answer.status, 404);
    });
});

describe('la réponse en ligne', () => {
    it('accepte le devis, garde la trace et prévient l’espace', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(
            docRow({
                id: 10,
                kind: 'quote',
                status: 'sent',
                public_token: 'jeton',
                valid_until: DAY,
                content: JSON.stringify({ subject: 'Refonte' })
            })
        );
        const { handlers, deps } = mount(store);

        const res = reply();
        await handlers.get('POST /api/invoicing/answer')!(
            request({
                body: { token: 'jeton', name: 'Camille Martin' },
                headers: { 'user-agent': 'Firefox' }
            }),
            res
        );

        const doc = store.docs.find((d) => d.id === 10);
        assert.equal(doc?.status, 'accepted');
        assert.ok((doc?.accepted_at ?? 0) > 0);
        assert.ok(doc?.content.includes('Camille Martin'));
        assert.ok(doc?.content.includes('203.0.113.7'), 'l’adresse est gardée comme preuve');
        assert.equal(res.answer.status, 303);
        assert.equal(res.answer.headers.location, '/f/jeton');
        assert.equal(deps.recorded.notifications.length, 1);
        assert.ok(deps.recorded.notifications[0].subject.includes('accepté'));
    });

    it('rejouée, ne change rien et ne prévient pas deux fois', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, kind: 'quote', status: 'sent', public_token: 'jeton' }));
        const { handlers, deps } = mount(store);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await handlers.get('POST /api/invoicing/answer')!(
                request({ body: { token: 'jeton', name: 'Camille' } }),
                reply()
            );
        }

        assert.equal(deps.recorded.notifications.length, 1);
        assert.equal(store.docs.find((d) => d.id === 10)?.status, 'accepted');
    });

    it('refuse le devis quand c’est le refus qui est cliqué', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, kind: 'quote', status: 'sent', public_token: 'jeton' }));
        const { handlers, deps } = mount(store);

        await handlers.get('POST /api/invoicing/answer')!(
            request({ body: { token: 'jeton', name: '', answer: 'decline' } }),
            reply()
        );

        const doc = store.docs.find((d) => d.id === 10);
        assert.equal(doc?.status, 'declined');
        assert.equal(doc?.accepted_at, null, 'un refus n’est pas un accord');
        assert.equal(deps.recorded.notifications.length, 1);
        assert.ok(deps.recorded.notifications[0].subject.includes('refusé'));
    });

    it('ne touche pas à une facture, même avec son jeton', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, public_token: 'jeton' }));
        const { handlers, deps } = mount(store);

        await handlers.get('POST /api/invoicing/answer')!(
            request({ body: { token: 'jeton', name: 'Camille' } }),
            reply()
        );

        assert.equal(store.docs.find((d) => d.id === 10)?.status, 'issued');
        assert.equal(deps.recorded.notifications.length, 0);
    });

    it('répond comme une page absente quand le jeton est inconnu', async () => {
        const store = emptyStore();
        const { handlers } = mount(store);
        const res = reply();
        await handlers.get('POST /api/invoicing/answer')!(request({ body: { token: 'inconnu' } }), res);
        assert.equal(res.answer.status, 404);
    });
});

describe('la page publique sous un domaine', () => {
    const domain = (over: Partial<SdkDomain>): SdkDomain => ({
        id: 1,
        workspaceId: 1,
        host: 'factures.dupont.fr',
        token: 'preuve-dupont',
        verified: true,
        verifiedAt: 1,
        ...over
    });

    it('rend le document sous un domaine de son espace', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, kind: 'invoice', status: 'issued', public_token: 'jeton' }));
        const { handlers } = mount(store, [domain({})]);

        const res = reply();
        await handlers.get('GET /f/:token')!(request({ host: 'factures.dupont.fr', params: { token: 'jeton' } }), res);
        assert.equal(res.answer.status, 200);
    });

    it('ne rend jamais le document d’un espace sous le domaine d’un autre', async () => {
        const store = emptyStore();
        readySettings(store);
        store.docs.push(docRow({ id: 10, kind: 'quote', status: 'sent', public_token: 'jeton' }));
        const { handlers } = mount(store, [domain({ workspaceId: 2, host: 'factures.voisin.fr' })]);

        for (const host of ['factures.voisin.fr', 'inconnu.exemple.fr']) {
            const page = reply();
            await handlers.get('GET /f/:token')!(request({ host, params: { token: 'jeton' } }), page);
            assert.equal(page.answer.status, 404, host);

            const answer = reply();
            await handlers.get('POST /api/invoicing/answer')!(
                request({ host, body: { token: 'jeton', name: 'Intrus', answer: 'accept' } }),
                answer
            );
            assert.equal(answer.answer.status, 404, host);
        }
        assert.equal(store.docs[0].status, 'sent');
    });

    it('rend la preuve du domaine à la sonde, et rien pour un nom inconnu', async () => {
        const { handlers } = mount(emptyStore(), [domain({})]);

        const known = reply();
        await handlers.get('GET /.well-known/deveye-invoicing')!(request({ host: 'factures.dupont.fr' }), known);
        assert.equal(known.answer.body, 'preuve-dupont');

        const unknown = reply();
        await handlers.get('GET /.well-known/deveye-invoicing')!(request({ host: 'ailleurs.fr' }), unknown);
        assert.equal(unknown.answer.status, 404);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkPublicApp, SdkPublicHandler, SdkPublicReply, SdkPublicRouteOptions } from '@deveye/types/sdk/server';

import { audienceRoutes } from './routes';
import { TRACKER_SCRIPT, TRACKER_SCRIPT_ETAG } from './script';
import type { AudienceIngest, IngestRequest, SubmitOutcome, SubmitRequest } from './service';

/**
 * Les routes publiques du module, sur une surface `SdkPublicApp` factice. On
 * tient ce que l'hôte ne vérifie pas pour nous : le script servi avec son type,
 * son cache et son ETag (un ETag connu rend `304`), un lot valide qui atteint
 * l'ingestion avec l'origine, le user-agent et l'adresse, un corps invalide qui
 * rend le même `204` sans l'atteindre, le plafond de débit de chaque POST, et
 * les réponses chargeables depuis une autre origine (CORP).
 *
 * Les retours ajoutent leurs propres pièges : deux formes de corps pour une
 * seule route, un pot de miel qui accepte sans écrire, et surtout une
 * redirection qui ne doit jamais mener ailleurs que sur le site d'où l'on vient.
 */

const KEY = 'pk_000000000000000000000001';

interface Route {
    method: 'get' | 'post';
    path: string;
    opts: SdkPublicRouteOptions;
    handler: SdkPublicHandler;
}

function fakeApp(): { app: SdkPublicApp; routes: Route[] } {
    const routes: Route[] = [];
    return {
        routes,
        app: {
            get: (path, opts, handler) => routes.push({ method: 'get', path, opts, handler }),
            post: (path, opts, handler) => routes.push({ method: 'post', path, opts, handler }),
            postStream: () => assert.fail('aucune route en flux attendue')
        }
    };
}

function fakeReply() {
    const state = { status: 200, headers: {} as Record<string, string>, payload: undefined as unknown };
    const reply: SdkPublicReply = {
        header(name, value) {
            state.headers[name] = value;
            return reply;
        },
        code(status) {
            state.status = status;
            return reply;
        },
        send(payload) {
            state.payload = payload;
            return reply;
        }
    };
    return { reply, state };
}

function mount(outcome: SubmitOutcome = { status: 'stored' }) {
    const accepted: IngestRequest[] = [];
    const submitted: SubmitRequest[] = [];
    const ingest = {
        accept: async (req: IngestRequest) => {
            accepted.push(req);
        },
        submit: async (req: SubmitRequest) => {
            submitted.push(req);
            return outcome;
        }
    } as unknown as AudienceIngest;
    const { app, routes } = fakeApp();
    audienceRoutes(app, ingest);
    const routeOf = (method: Route['method'], path: string) => {
        const route = routes.find((r) => r.method === method && r.path === path);
        assert.ok(route, `route ${method} ${path} manquante`);
        return route;
    };
    return { routes, accepted, submitted, routeOf };
}

const headers = {
    origin: 'https://exemple.fr',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0'
};

describe('la déclaration', () => {
    it('déclare le script et les trois points d’entrée, les POST avec leur plafond', () => {
        const { routes } = mount();
        assert.deepEqual(
            routes.map((r) => [r.method, r.path, r.opts.rateLimit ?? null, r.opts.bodyLimit ?? null]),
            [
                ['get', '/t.js', null, null],
                // Le plafond de corps compte autant que celui de débit : le défaut
                // de l'hôte vaut un mégaoctet, analysé avant toute validation.
                ['post', '/api/t/b', { max: 600, timeWindow: '1 minute' }, 64 * 1024],
                ['post', '/api/t/e', { max: 600, timeWindow: '1 minute' }, 8 * 1024],
                // Bien plus serré que la mesure : une requête de retour écrit une
                // ligne et chiffre, là où une mesure range un entier dans une file.
                ['post', '/api/t/s', { max: 30, timeWindow: '1 minute' }, 256 * 1024]
            ]
        );
    });
});

describe('GET /t.js', () => {
    it('sert le script avec son type, son cache, son ETag, chargeable d’ailleurs', async () => {
        const { routeOf } = mount();
        const { reply, state } = fakeReply();
        await routeOf('get', '/t.js').handler({ headers: {}, body: undefined, ip: '203.0.113.7' }, reply);
        assert.equal(state.status, 200);
        assert.equal(state.payload, TRACKER_SCRIPT);
        assert.equal(state.headers['Content-Type'], 'application/javascript; charset=utf-8');
        assert.equal(state.headers['Cache-Control'], 'public, max-age=3600');
        assert.equal(state.headers['ETag'], TRACKER_SCRIPT_ETAG);
        assert.equal(state.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    });

    it('rend 304 sans corps sur un ETag connu', async () => {
        const { routeOf } = mount();
        const { reply, state } = fakeReply();
        await routeOf('get', '/t.js').handler(
            { headers: { 'if-none-match': TRACKER_SCRIPT_ETAG }, body: undefined, ip: '203.0.113.7' },
            reply
        );
        assert.equal(state.status, 304);
        assert.equal(state.payload, undefined);
        assert.equal(state.headers['ETag'], TRACKER_SCRIPT_ETAG);
    });
});

describe('POST /api/t/b', () => {
    it('transmet un lot valide à l’ingestion, avec l’origine, le user-agent et l’adresse', async () => {
        const { routeOf, accepted } = mount();
        const { reply, state } = fakeReply();
        const body = {
            key: KEY,
            visitorId: 'v-1',
            events: [
                { type: 'view', path: '/' },
                { type: 'event', path: '/', name: 'clic' }
            ]
        };
        await routeOf('post', '/api/t/b').handler({ headers, body, ip: '203.0.113.7' }, reply);
        assert.equal(state.status, 204);
        assert.equal(state.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
        assert.deepEqual(accepted, [
            {
                key: KEY,
                visitorId: 'v-1',
                origin: 'https://exemple.fr',
                ip: '203.0.113.7',
                userAgent: headers['user-agent'],
                events: body.events
            }
        ]);
    });

    it('rend le même 204 sur un corps invalide, sans atteindre l’ingestion', async () => {
        const { routeOf, accepted } = mount();
        for (const body of [
            undefined,
            'texte',
            { key: 'court', events: [{ type: 'view', path: '/' }] },
            { key: KEY, events: [] }
        ]) {
            const { reply, state } = fakeReply();
            await routeOf('post', '/api/t/b').handler({ headers, body, ip: '203.0.113.7' }, reply);
            assert.equal(state.status, 204);
        }
        assert.deepEqual(accepted, []);
    });
});

describe('POST /api/t/e', () => {
    it('écarte une clé qui n’a pas la bonne longueur, avant d’atteindre l’ingestion', async () => {
        // Le schéma de l'événement ne porte pas la clé : sans cette confrontation,
        // une chaîne quelconque descend jusqu'au cache des clés inconnues, qui
        // borne son nombre d'entrées et non leurs octets.
        const { routeOf, accepted } = mount();
        for (const key of ['x'.repeat(10_000), 'pk_court', '']) {
            const { reply, state } = fakeReply();
            await routeOf('post', '/api/t/e').handler(
                { headers: {}, body: { key, type: 'view', path: '/x' }, ip: '203.0.113.7' },
                reply
            );
            assert.equal(state.status, 204, `longueur ${key.length}`);
        }
        assert.deepEqual(accepted, []);
    });

    it('transmet un événement isolé, `Origin` absent compris (un client natif n’en envoie pas)', async () => {
        const { routeOf, accepted } = mount();
        const { reply, state } = fakeReply();
        await routeOf('post', '/api/t/e').handler(
            {
                headers: { 'user-agent': 'curl/8.0' },
                body: { key: KEY, type: 'event', path: '/x', name: 'ping' },
                ip: '203.0.113.7'
            },
            reply
        );
        assert.equal(state.status, 204);
        assert.deepEqual(
            accepted.map((a) => [a.key, a.origin, a.userAgent, a.visitorId, a.events.length, a.events[0].name]),
            [[KEY, null, 'curl/8.0', null, 1, 'ping']]
        );
    });

    it('sans clé, rien n’atteint l’ingestion', async () => {
        const { routeOf, accepted } = mount();
        const { reply, state } = fakeReply();
        await routeOf('post', '/api/t/e').handler(
            { headers, body: { type: 'view', path: '/' }, ip: '203.0.113.7' },
            reply
        );
        assert.equal(state.status, 204);
        assert.deepEqual(accepted, []);
    });
});

describe('POST /api/t/s', () => {
    const submit = async (
        body: unknown,
        extra: Record<string, string> = {},
        outcome: SubmitOutcome = { status: 'stored' }
    ) => {
        const { routeOf, submitted } = mount(outcome);
        const { reply, state } = fakeReply();
        await routeOf('post', '/api/t/s').handler(
            { headers: { ...headers, ...extra }, body, ip: '203.0.113.7' },
            reply
        );
        return { submitted, state };
    };

    const jsonBody = { key: KEY, form: 'contact', fields: { email: 'a@exemple.fr' } };

    it('accepte un corps JSON et le passe à l’ingestion, chargeable d’ailleurs', async () => {
        const { submitted, state } = await submit(jsonBody);
        assert.equal(state.status, 200);
        assert.deepEqual(state.payload, { ok: true });
        assert.equal(state.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].form, 'contact');
        assert.equal(submitted[0].origin, 'https://exemple.fr');
        assert.equal(submitted[0].ip, '203.0.113.7');
    });

    it('nomme le seul refus qui ne dit rien des clés : la forme du corps', async () => {
        // Un `400` ici est une propriété de la requête envoyée. Sans lui, une
        // intégration fautive n'aurait aucun moyen de se voir.
        const { submitted, state } = await submit({ key: KEY, fields: {} });
        assert.equal(state.status, 400);
        assert.equal(submitted.length, 0);
    });

    it('rend le même 200 sur une clé inconnue : c’est à l’ingestion de refuser', async () => {
        const { state } = await submit({ ...jsonBody, key: 'pk_000000000000000000000009' });
        assert.equal(state.status, 200);
        assert.deepEqual(state.payload, { ok: true });
    });

    it('aplatit un envoi de formulaire HTML, réservés ôtés, et redirige sur place', async () => {
        const { submitted, state } = await submit({
            _key: KEY,
            _form: 'sondage',
            _next: '/merci.html',
            email: 'a@exemple.fr',
            canaux: ['mail', 'sms']
        });
        assert.equal(submitted.length, 1);
        assert.deepEqual(submitted[0].fields, { email: 'a@exemple.fr', canaux: ['mail', 'sms'] });
        assert.equal(state.status, 303);
        assert.equal(state.headers.Location, 'https://exemple.fr/merci.html');
    });

    it('refuse de renvoyer ailleurs que sur l’origine de l’envoi', async () => {
        // Sans cette garde, la route serait un redirecteur ouvert : n'importe qui
        // pourrait faire pointer un lien « vers DevEye » sur son propre site.
        for (const next of ['https://pirate.fr/merci', 'javascript:alert(1)', '//pirate.fr']) {
            const { state } = await submit({ _key: KEY, _form: 'contact', _next: next, message: 'bonjour' });
            assert.equal(state.status, 200, next);
            assert.equal(state.headers.Location, undefined, next);
            assert.equal(state.headers['Content-Type'], 'text/html; charset=utf-8', next);
        }
    });

    it('sert la page de remerciement quand le site n’a pas dit où renvoyer', async () => {
        const { submitted, state } = await submit({ _key: KEY, _form: 'contact', message: 'bonjour' });
        assert.equal(submitted.length, 1);
        assert.equal(state.status, 200);
        assert.equal(state.headers['Content-Type'], 'text/html; charset=utf-8');
        assert.match(String(state.payload), /Merci/);
    });

    it('accepte sans rien écrire quand le pot de miel est rempli', async () => {
        const { submitted, state } = await submit({ _key: KEY, _form: 'contact', _hp: 'robot', message: 'bonjour' });
        assert.equal(submitted.length, 0, 'rien ne descend jusqu’à l’ingestion');
        // La réponse est celle d'un envoi réussi : un robot qui se sait vu essaie
        // autre chose.
        assert.equal(state.status, 200);
        assert.match(String(state.payload), /Merci/);
    });

    it('nomme le champ refusé au lieu de remercier, sur un `<form>` sans JavaScript', async () => {
        // Le pire mode d'échec de la route : un remerciement sur un message
        // jamais écrit. Personne ne le découvre, ni le visiteur ni le site.
        const cases: [Record<string, unknown>, RegExp][] = [
            // Une clé mal recopiée dans la page : la longueur ne colle pas.
            [{ _key: 'pk_trop-court', _form: 'contact', message: 'bonjour' }, /_key/],
            // Un message plus long que ce qu'un retour conserve.
            [{ _key: KEY, _form: 'contact', message: 'x'.repeat(5000) }, /message/]
        ];
        for (const [body, names] of cases) {
            const { submitted, state } = await submit(body);
            assert.equal(state.status, 400, JSON.stringify(Object.keys(body)));
            assert.equal(state.headers['Content-Type'], 'text/html; charset=utf-8');
            assert.match(String(state.payload), /refusé/);
            assert.match(String(state.payload), names);
            assert.equal(submitted.length, 0);
        }
    });

    it('garde le remerciement quand le pot de miel est rempli, corps illisible compris', async () => {
        // Le piège l'emporte sur le refus : nommer le champ à un robot lui
        // apprendrait qu'il a été vu, et il essaierait autre chose.
        const { submitted, state } = await submit({ _key: KEY, _hp: 'robot', message: 'x'.repeat(5000) });
        assert.equal(state.status, 200);
        assert.match(String(state.payload), /Merci/);
        assert.equal(submitted.length, 0);
    });

    it('ignore `_next` quand la requête n’a pas d’origine (curl, appel serveur)', async () => {
        const { routeOf, submitted } = mount();
        const { reply, state } = fakeReply();
        await routeOf('post', '/api/t/s').handler(
            {
                headers: {},
                body: { _key: KEY, _form: 'contact', _next: '/merci', message: 'bonjour' },
                ip: '203.0.113.7'
            },
            reply
        );
        assert.equal(submitted.length, 1);
        assert.equal(state.headers.Location, undefined);
    });

    it('avoue une panne d’écriture plutôt que d’annoncer un message reçu', async () => {
        // Le seul autre refus qu'on nomme. Répondre « reçu » sur une écriture qui a
        // échoué ferait dire au site « message envoyé » sur un message perdu, ce
        // que l'écriture synchrone cherchait précisément à éviter.
        const json = await submit(jsonBody, {}, { status: 'failed' });
        assert.equal(json.state.status, 503);
        assert.deepEqual(json.state.payload, { ok: false });

        // Et le visiteur d'un `<form>` n'est pas envoyé sur la page de remerciement.
        const form = await submit(
            { _key: KEY, _form: 'contact', _next: '/merci', message: 'a' },
            {},
            { status: 'failed' }
        );
        assert.equal(form.state.status, 503);
        assert.equal(form.state.headers.Location, undefined);
        assert.match(String(form.state.payload), /réessayer/);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkDomain, SdkPublicApp, SdkPublicReply, SdkPublicRequest } from '@deveye/types/sdk/server';
import { createTestServiceDeps, testDomain } from '@deveye/types/sdk/testing';

import type { UptimeIncidentRow, UptimePageRow, UptimeServiceRow } from '../../contracts/domain';
import type { UptimeRepo } from '../repo';
import type { UptimePagesRepo, UptimeStatusRepo, UptimeStatusServiceRow } from '../repoPages';
import { createStatusPages } from './routes';
import { STATUS_SCRIPT_ETAG } from './script';

/**
 * Les routes publiques des pages de statut : une page ne se montre que sous
 * l'adresse de DevEye ou sous un domaine de son espace, une page retirée ne dit
 * rien de plus qu'une page inconnue, et rien de ce qui n'est pas à montrer
 * (l'adresse sondée, le message d'une panne) n'arrive dans le document.
 */

interface Answer {
    status: number;
    headers: Record<string, string>;
    body: string;
}

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

const REF = '0123456789abcdef';

function page(over: Partial<UptimePageRow> = {}): UptimePageRow {
    return {
        id: 1,
        workspace_id: 1,
        public_ref: REF,
        content: JSON.stringify({ title: 'Nos <services>', description: 'Tout ce que nous faisons tourner.' }),
        domain_id: null,
        theme: 'auto',
        show_errors: 0,
        show_latency: 0,
        enabled: 1,
        created: 1,
        ...over
    };
}

function service(id: number, over: Partial<UptimeServiceRow> = {}): UptimeStatusServiceRow {
    return {
        id,
        user_id: 1,
        workspace_id: 1,
        content: JSON.stringify({
            name: `Interne ${id}`,
            url: `https://interne.exemple.fr/${id}`,
            keyword: 'jeton-secret'
        }),
        method: 'GET',
        expected_status: null,
        interval_seconds: 60,
        timeout_seconds: 10,
        failure_threshold: 2,
        retention_days: null,
        enabled: 1,
        sort_order: id,
        status: 'down',
        consecutive_failures: 3,
        last_checked_at: 1,
        last_response_ms: null,
        last_http_status: null,
        last_error: null,
        created: 1,
        page_label: id === 1 ? 'API publique' : null,
        ...over
    };
}

/** `paused` : les pauses d'offre par clé, lues à chaque visite (le test les change en route). */
function mount(pages: UptimePageRow[], domains: readonly SdkDomain[] = [], paused: Record<string, string[]> = {}) {
    const lookups = { byRef: 0 };
    const now = Math.floor(Date.now() / 1000);
    const incidents: UptimeIncidentRow[] = [
        {
            id: 1,
            service_id: 1,
            started_at: now - 600,
            ended_at: null,
            http_status: null,
            error: 'connect ECONNREFUSED 10.0.0.5:443',
            notified: 1
        }
    ];
    const repo = {
        pages: {
            findByRef: async (ref: string) => {
                lookups.byRef += 1;
                return pages.find((p) => p.public_ref === ref) ?? null;
            },
            findByDomain: async (domainId: number) => pages.find((p) => p.domain_id === domainId) ?? null
        } as Partial<UptimePagesRepo>,
        status: {
            servicesOf: async () => [service(1), service(2, { status: 'up', consecutive_failures: 0 })],
            dailyOf: async () => [],
            incidentsOf: async () => incidents,
            hourlyLatencyOf: async () => []
        } satisfies UptimeStatusRepo
    } as unknown as UptimeRepo;
    const deps = createTestServiceDeps({ repo, domains, pausedItems: paused });
    const status = createStatusPages(deps);
    const handlers = new Map<string, (req: SdkPublicRequest, res: SdkPublicReply) => Promise<unknown>>();
    const app: SdkPublicApp = {
        get: (path, _opts, handler) => handlers.set(path, handler),
        post: () => undefined,
        postStream: () => undefined
    };
    status.routes(app);
    const get = async (path: string, over: Partial<SdkPublicRequest> = {}) => {
        const res = reply();
        await handlers.get(path)!(
            { headers: {}, host: 'public.deveye.test', body: undefined, ip: '203.0.113.7', ...over },
            res
        );
        return res.answer;
    };
    return { status, get, lookups };
}

const statusPage = (m: ReturnType<typeof mount>, over: Partial<SdkPublicRequest> = {}) =>
    m.get('/statut/:ref', { params: { ref: REF }, ...over });

describe('la page publique', () => {
    it('rend la page sous l’adresse de DevEye, avec sa politique et hors des moteurs de recherche', async () => {
        const res = await statusPage(mount([page()]));
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /text\/html/);
        assert.match(res.headers['content-security-policy'] ?? '', /default-src 'none'/);
        assert.match(res.headers['content-security-policy'] ?? '', /frame-ancestors \*/);
        assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
        assert.ok(res.body.includes('Nos &lt;services&gt;'));
        assert.ok(res.body.includes('API publique'));
        assert.ok(res.body.includes('Interne 2'));
        assert.ok(res.body.includes('Panne en cours sur 1 service sur 2'));
        assert.ok(res.body.includes('<script src="/statut/page.js" defer></script>'));
    });

    it('ne laisse sortir ni l’adresse sondée, ni le mot-clé, ni le message d’une panne', async () => {
        for (const showErrors of [0, 1]) {
            const res = await statusPage(mount([page({ show_errors: showErrors })]));
            assert.ok(!res.body.includes('interne.exemple.fr'));
            assert.ok(!res.body.includes('jeton-secret'));
            assert.ok(!res.body.includes('10.0.0.5'));
            assert.equal(res.body.includes('Connexion impossible'), showErrors === 1);
        }
    });

    it('répond « introuvable » pareil pour une page inconnue, retirée ou mal nommée', async () => {
        const m = mount([page({ enabled: 0 })]);
        const retired = await statusPage(m);
        const unknown = await m.get('/statut/:ref', { params: { ref: 'ffffffffffffffff' } });
        const malformed = await m.get('/statut/:ref', { params: { ref: '../admin' } });
        for (const res of [retired, unknown, malformed]) {
            assert.equal(res.status, 404);
            assert.ok(res.body.includes('Page introuvable'));
        }
        assert.equal(retired.body, unknown.body);
    });

    it('se montre sous un domaine de son espace, jamais sous celui d’un autre', async () => {
        const domains = [
            testDomain({ id: 5, host: 'statut.exemple.fr', workspaceId: 1 }),
            testDomain({ id: 6, host: 'statut.autre.fr', workspaceId: 42 }),
            testDomain({ id: 7, host: 'attente.exemple.fr', workspaceId: 1, verified: false })
        ];
        const m = mount([page()], domains);
        const own = await statusPage(m, { host: 'statut.exemple.fr' });
        assert.equal(own.status, 200);
        assert.equal(own.headers['x-robots-tag'], undefined);
        assert.equal((await statusPage(m, { host: 'statut.autre.fr' })).status, 404);
        assert.equal((await statusPage(m, { host: 'attente.exemple.fr' })).status, 404);
        assert.equal((await statusPage(m, { host: 'nimporte.quoi' })).status, 404);
    });

    it('se calcule une fois pour les visites suivantes, et se relit après une écriture', async () => {
        const m = mount([page()]);
        await Promise.all([statusPage(m), statusPage(m), statusPage(m)]);
        assert.equal(m.lookups.byRef, 1);
        await statusPage(m);
        assert.equal(m.lookups.byRef, 1);
        m.status.forget(1);
        await statusPage(m);
        assert.equal(m.lookups.byRef, 2);
    });
});

describe('la pause de l’offre', () => {
    it('répond « introuvable » comme une page retirée, dès la visite suivante, puis revient', async () => {
        const pages: string[] = [];
        const bound = testDomain({ id: 5, host: 'statut.exemple.fr', workspaceId: 1 });
        const m = mount([page({ domain_id: 5 })], [bound], { pages });
        const atRoot = async () => {
            const res = reply();
            await m.status.root({ headers: {}, host: bound.host, body: undefined, ip: '203.0.113.7' }, res, bound);
            return res.answer;
        };
        assert.equal((await statusPage(m)).status, 200);
        assert.equal((await atRoot()).status, 200);

        // Relue après le cache : la page en cache ne la sert plus, sans rien oublier.
        pages.push('1');
        const paused = await statusPage(m);
        assert.equal(paused.status, 404);
        assert.equal((await atRoot()).status, 404);
        assert.equal(m.lookups.byRef, 1);
        assert.equal(paused.body, (await m.get('/statut/:ref', { params: { ref: 'ffffffffffffffff' } })).body);

        pages.length = 0;
        assert.equal((await statusPage(m)).status, 200);
    });

    it('n’est pas calculée quand elle est déjà en pause', async () => {
        const m = mount([page()], [], { pages: ['1'] });
        assert.equal((await statusPage(m)).status, 404);
        assert.equal((await statusPage(m)).status, 404);
        // Rien en cache : chaque visite relit la ligne, comme pour une page retirée.
        assert.equal(m.lookups.byRef, 2);
    });

    it('montre en pause un service que l’offre tient en pause, et ne le compte pas', async () => {
        const res = await statusPage(mount([page()], [], { monitors: ['1'] }));
        assert.equal(res.status, 200);
        // Le service 1 était en panne : en pause, seul le service 2 est surveillé.
        assert.ok(res.body.includes('Le service fonctionne'));
    });
});

describe('la racine d’un domaine', () => {
    it('sert la page que ce domaine désigne, et rien d’autre', async () => {
        const bound = testDomain({ id: 5, host: 'statut.exemple.fr', workspaceId: 1 });
        const m = mount([page({ domain_id: 5 })], [bound]);
        const res = reply();
        await m.status.root({ headers: {}, host: bound.host, body: undefined, ip: '203.0.113.7' }, res, bound);
        assert.equal(res.answer.status, 200);
        assert.ok(res.answer.body.includes('API publique'));

        const empty = reply();
        const other = testDomain({ id: 8, host: 'vide.exemple.fr', workspaceId: 1 });
        await m.status.root({ headers: {}, host: other.host, body: undefined, ip: '203.0.113.7' }, empty, other);
        assert.equal(empty.answer.status, 404);
    });
});

describe('le script et la preuve du domaine', () => {
    it('sert le script une fois, puis le laisse au cache du navigateur', async () => {
        const m = mount([]);
        const first = await m.get('/statut/page.js');
        assert.equal(first.status, 200);
        assert.equal(first.headers.etag, STATUS_SCRIPT_ETAG);
        const again = await m.get('/statut/page.js', { headers: { 'if-none-match': STATUS_SCRIPT_ETAG } });
        assert.equal(again.status, 304);
        assert.equal(again.body, '');
    });

    it('rend le jeton d’un domaine connu, et rien pour un autre', async () => {
        const m = mount([], [testDomain({ id: 5, host: 'statut.exemple.fr', token: 'jeton-du-domaine' })]);
        const known = await m.get('/.well-known/deveye-uptime', { host: 'statut.exemple.fr' });
        assert.equal(known.body, 'jeton-du-domaine');
        assert.equal((await m.get('/.well-known/deveye-uptime', { host: 'autre.exemple.fr' })).status, 404);
    });
});

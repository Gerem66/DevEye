import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AudienceSiteRow } from '../contracts/domain';
import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { dayKey } from './normalize';
import { serverEntry } from './index';
import type { AudienceRepo, NewSessionInput, PendingEventRow } from './repo';
import { AudienceIngest, type IngestRequest } from './service';

/**
 * L'ingestion du module, sur le harnais de service du SDK. Aucune horloge ni
 * réseau à simuler : le dépôt en mémoire retient ce qu'on lui écrit et les deux
 * tickers se battent à la main. On tient l'événement accepté qui entre en base
 * à la vidange, le refus qui n'écrit rien, le direct coalescé, `invalidate` qui
 * fait relire un site, le ménage qui agrège puis élague, et le sel des
 * visiteurs stable d'une instance à l'autre.
 */

interface FakeRepo extends AudienceRepo {
    sites: AudienceSiteRow[];
    sessions: (NewSessionInput & { id: number; touched: number; identityId: number | null })[];
    events: PendingEventRow[];
    labels: Map<string, number>;
    touchedSites: [number, number][];
    rollups: [number, number, number, number][];
    pruned: { events: [number, number][]; sessions: [number, number][]; labels: number[] };
}

const KEY = 'pk_000000000000000000000001';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

function site(over: Partial<AudienceSiteRow> = {}): AudienceSiteRow {
    return {
        id: 1,
        workspace_id: 1,
        public_key: KEY,
        name_ref: 'ref-1',
        platform: 'web',
        visitor_mode: 'anonymous',
        origins: 'exemple.fr',
        active: 1,
        retention_days: 30,
        sort_order: 0,
        last_event_at: null,
        content: JSON.stringify({ name: 'Vitrine', description: '' }),
        created: 1,
        ...over
    };
}

/** Un dépôt en mémoire ; le harnais chiffre à l'identité, donc les libellés sont en clair. */
function fakeRepo(sites: AudienceSiteRow[]): FakeRepo {
    let seq = 0;
    const repo: FakeRepo = {
        sites,
        sessions: [],
        events: [],
        labels: new Map(),
        touchedSites: [],
        rollups: [],
        pruned: { events: [], sessions: [], labels: [] },
        list: unused,
        listVisible: unused,
        find: async (id, workspaceId) => sites.find((s) => s.id === id && s.workspace_id === workspaceId) ?? null,
        findVisible: unused,
        findWithStats: unused,
        findByName: unused,
        count: unused,
        create: unused,
        update: unused,
        setPublicKey: unused,
        remove: unused,
        reorder: unused,
        metrics: unused,
        returningVisitors: unused,
        points: unused,
        breakdown: unused,
        activity: unused,
        liveVisitors: unused,
        livePages: unused,
        listFunnels: unused,
        listFunnelSteps: unused,
        findFunnelInWorkspace: unused,
        findFunnelByName: unused,
        countFunnels: unused,
        createFunnel: unused,
        renameFunnel: unused,
        removeFunnel: unused,
        replaceFunnelSteps: unused,
        resolveLabels: unused,
        retention: unused,
        findByPublicKey: async (publicKey) => sites.find((s) => s.public_key === publicKey) ?? null,
        // Comme `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` : la même
        // valeur rend le même identifiant, le contenu n'est jamais réécrit.
        async resolveLabel(siteId, kind, _labelRef, content) {
            const key = `${siteId}:${kind}:${content}`;
            const hit = repo.labels.get(key);
            if (hit !== undefined) return hit;
            const id = ++seq;
            repo.labels.set(key, id);
            return id;
        },
        findOpenSession: async (siteId, visitorRef, since) => {
            const open = repo.sessions.find((s) => s.siteId === siteId && s.visitorRef === visitorRef && s.at >= since);
            return open ? { id: open.id, views: open.touched, identity_id: open.identityId } : null;
        },
        async createSession(input) {
            const id = ++seq;
            repo.sessions.push({ ...input, id, touched: 0 });
            return id;
        },
        async touchSession(id, _at, viewsDelta) {
            const s = repo.sessions.find((x) => x.id === id);
            if (s) s.touched += viewsDelta;
        },
        async setSessionIdentity(id, identityId) {
            const s = repo.sessions.find((x) => x.id === id);
            if (s) s.identityId = identityId;
        },
        async insertEvents(rows) {
            repo.events.push(...rows);
        },
        async touchSite(siteId, at) {
            repo.touchedSites.push([siteId, at]);
        },
        listForMaintenance: async () =>
            sites.map((s) => ({ id: s.id, workspace_id: s.workspace_id, retention_days: s.retention_days })),
        async rollupDay(siteId, day, from, to) {
            repo.rollups.push([siteId, day, from, to]);
        },
        async pruneEvents(siteId, before) {
            repo.pruned.events.push([siteId, before]);
            return 3;
        },
        async pruneSessions(siteId, before) {
            repo.pruned.sessions.push([siteId, before]);
            return 0;
        },
        async pruneOrphanLabels(siteId) {
            repo.pruned.labels.push(siteId);
            return 1;
        }
    };
    return repo;
}

async function unused(): Promise<never> {
    throw new Error('non attendu ici');
}

function request(over: Partial<IngestRequest> = {}): IngestRequest {
    return {
        key: KEY,
        origin: 'https://exemple.fr',
        ip: '203.0.113.7',
        userAgent: UA,
        events: [{ type: 'view', path: '/tarifs/' }],
        ...over
    };
}

/** Le service sur le harnais : les deux tickers, dans l'ordre où le service les pose. */
function ingestWith(repo: FakeRepo) {
    const deps = createTestServiceDeps({ repo });
    const ingest = new AudienceIngest(deps);
    return {
        deps,
        ingest,
        flush: () => deps.recorded.tickers[0].tick(),
        maintain: () => deps.recorded.tickers[1].tick()
    };
}

describe('accepter puis vider', () => {
    it('pose deux tickers (une seconde, une heure), et un événement accepté entre en base à la vidange', async () => {
        const repo = fakeRepo([site()]);
        const { deps, ingest, flush } = ingestWith(repo);
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [1_000, 3_600_000]
        );

        await ingest.accept(
            request({ events: [{ type: 'view', path: '/tarifs/?utm=x', referrer: 'https://google.fr/q' }] })
        );
        // Rien n'est écrit dans la requête.
        assert.equal(repo.events.length, 0);
        assert.equal(repo.sessions.length, 0);

        await flush();
        // Une session, avec ses dimensions posées à l'ouverture (chemin
        // d'entrée normalisé, référent réduit à l'hôte, navigateur lu du
        // user-agent), et un fait qui pointe le libellé du chemin.
        assert.equal(repo.sessions.length, 1);
        const session = repo.sessions[0];
        assert.equal(session.siteId, 1);
        assert.equal(session.touched, 1);
        const labelOf = (kind: string, value: string) => repo.labels.get(`1:${kind}:${value}`);
        assert.equal(session.entryPathId, labelOf('path', '/tarifs'));
        assert.equal(session.referrerId, labelOf('referrer', 'google.fr'));
        assert.equal(session.browserId, labelOf('browser', 'Firefox'));
        assert.equal(session.osId, labelOf('os', 'Linux'));
        assert.equal(session.deviceId, labelOf('device', 'desktop'));
        assert.deepEqual(
            repo.events.map((e) => [e.siteId, e.sessionId, e.kind, e.pathId, e.nameId]),
            [[1, session.id, 0, labelOf('path', '/tarifs'), null]]
        );
        assert.deepEqual(
            repo.touchedSites.map(([id]) => id),
            [1]
        );
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('une identité arrivée en cours de visite rattache la session déjà ouverte', async () => {
        const repo = fakeRepo([site()]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        await flush();
        await ingest.accept(
            request({ events: [{ type: 'event', path: '/compte', name: 'connexion', identity: 'alice' }] })
        );
        await flush();
        assert.equal(repo.sessions.length, 1);
        assert.equal(repo.sessions[0].identityId, repo.labels.get('1:identity:alice'));
        assert.deepEqual(
            repo.events.map((e) => [e.kind, e.nameId]),
            [
                [0, null],
                [1, repo.labels.get('1:event:connexion')]
            ]
        );
    });
});

describe('les refus', () => {
    it('une origine refusée, une clé inconnue, un robot : rien n’entre, rien ne part', async () => {
        const repo = fakeRepo([site()]);
        const { deps, ingest, flush } = ingestWith(repo);
        await ingest.accept(request({ origin: 'https://autre.fr' }));
        await ingest.accept(request({ origin: null }));
        await ingest.accept(request({ key: 'pk_000000000000000000000009' }));
        await ingest.accept(request({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }));
        await ingest.accept(request({ events: [{ type: 'event', path: '/', name: '  ' }] }));
        await flush();
        assert.equal(repo.events.length, 0);
        assert.equal(repo.sessions.length, 0);
        assert.deepEqual(deps.recorded.liveChanges, []);
    });

    it('un site éteint n’accepte plus rien ; un site `app` accepte sans `Origin`', async () => {
        const repo = fakeRepo([
            site({ active: 0 }),
            site({ id: 2, public_key: 'pk_000000000000000000000002', platform: 'app' })
        ]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        await ingest.accept(request({ key: 'pk_000000000000000000000002', origin: null }));
        await flush();
        assert.deepEqual(
            repo.events.map((e) => e.siteId),
            [2]
        );
    });
});

describe('le direct, coalescé', () => {
    it('deux vidanges dans la même minute ne produisent qu’un battement par espace', async () => {
        const repo = fakeRepo([site(), site({ id: 2, workspace_id: 2, public_key: 'pk_000000000000000000000002' })]);
        const { deps, ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        await flush();
        await ingest.accept(request());
        await ingest.accept(request({ key: 'pk_000000000000000000000002' }));
        await flush();
        assert.equal(repo.events.length, 3);
        assert.deepEqual(deps.recorded.liveChanges, [1, 2]);
    });
});

describe('le cache des sites', () => {
    it('`invalidate` fait relire un site que le cache tenait pour actif', async () => {
        const repo = fakeRepo([site()]);
        const { ingest, flush } = ingestWith(repo);
        await ingest.accept(request());
        // Éteint en base : le cache, lui, ne le sait pas encore.
        repo.sites[0].active = 0;
        await ingest.accept(request());
        await flush();
        assert.equal(repo.events.length, 2);

        ingest.invalidate();
        await ingest.accept(request());
        await flush();
        assert.equal(repo.events.length, 2);
    });
});

describe('le ménage', () => {
    it('agrège hier et aujourd’hui, élague à la rétention du site, et balaie les libellés orphelins', async () => {
        const repo = fakeRepo([site({ retention_days: 30 })]);
        const { maintain } = ingestWith(repo);
        const before = Math.floor(Date.now() / 1000);
        await maintain();
        const after = Math.floor(Date.now() / 1000);

        assert.deepEqual(
            repo.rollups.map(([siteId, day, from, to]) => [siteId, day, to - from]),
            [
                [1, dayKey(before - 86400), 86400],
                [1, dayKey(before), 86400]
            ]
        );
        assert.equal(repo.pruned.events.length, 1);
        const [siteId, cutoff] = repo.pruned.events[0];
        assert.equal(siteId, 1);
        assert.ok(cutoff >= before - 30 * 86400 && cutoff <= after - 30 * 86400);
        assert.deepEqual(repo.pruned.sessions, [[1, cutoff]]);
        // Quelque chose a disparu : les libellés sont balayés.
        assert.deepEqual(repo.pruned.labels, [1]);
    });
});

describe('le sel des visiteurs', () => {
    it('est dérivé de la clé serveur par le SDK, une fois, et vaut d’une instance à l’autre', async () => {
        const repo = fakeRepo([site({ visitor_mode: 'persistent' })]);
        const deps = createTestServiceDeps({ repo });
        const asked: [string, string, number][] = [];
        const derive = deps.keys.derive;
        deps.keys = {
            ...deps.keys,
            derive: (salt, info, length) => {
                asked.push([salt, info, length]);
                return derive(salt, info, length);
            }
        };

        const first = new AudienceIngest(deps);
        assert.deepEqual(asked, [['audience', 'visitor-salt', 32]]);

        // Un visiteur persistant est reconnu à l'identique par un second
        // processus : le sel ne dépend que de la clé serveur.
        await first.accept(request({ visitorId: 'abc-123' }));
        await deps.recorded.tickers[0].tick();
        const second = new AudienceIngest(deps);
        await second.accept(request({ visitorId: 'abc-123', ip: '198.51.100.4' }));
        await deps.recorded.tickers[2].tick();
        assert.equal(repo.sessions.length, 1);
        assert.equal(repo.sessions[0].touched, 2);
        assert.equal(asked.length, 2);
    });
});

/** Le contrat offert à Projets, tel que `createService` le publie au boot. */
function itemsProviderOn(repo: FakeRepo): AudienceItemsProvider {
    const service = serverEntry.createService?.(createTestServiceDeps({ repo }));
    assert.ok(service, 'le module crée un service');
    const provider = service.providers?.[AUDIENCE_ITEMS_PROVIDER] as AudienceItemsProvider | undefined;
    assert.ok(provider, 'le service publie le contrat des éléments');
    return provider;
}

describe('AUDIENCE_ITEMS_PROVIDER : labelOf', () => {
    it("rend le nom déchiffré d'un site vivant, null pour un identifiant inconnu ou un autre espace", async () => {
        const provider = itemsProviderOn(fakeRepo([site()]));
        assert.equal(await provider.labelOf(1, 1), 'Vitrine');
        assert.equal(await provider.labelOf(42, 1), null);
        assert.equal(await provider.labelOf(1, 2), null);
    });
});

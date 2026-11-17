import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { manifest } from '../manifest';
import { pacificToday } from './days';
import { AppStoresSync } from './service';
import type { AppleClient, AppleSalesRow } from './stores/apple';
import type { GoogleClient, VitalsDay } from './stores/google';
import type { StoreClients } from './stores/index';
import { StoreError, type StoreReview } from './stores/types';
import { appRow, fakeRepo, listingRow, sourceRow, type FakeRepo } from './_testing';
import type { ListingRow, SourceRow } from './repo';

/**
 * La synchronisation de fond, sans réseau ni base : les clients des stores
 * sont des doubles, l'horloge est celle du test. On tient ce qui ne se voit
 * qu'à l'usage : les pauses écartées, le repli d'une source, la perte d'une
 * clé dite une fois, le premier passage muet, les avis groupés, les étapes
 * d'une version, les seuils de stabilité, et un arrêt qui attend ses passes.
 */

/** Le 16 novembre 2026 à midi, heure du Pacifique. */
const START = Date.UTC(2026, 10, 16, 20, 0, 0);
const LATEST = pacificToday(START) - 1;
const HOUR = 3600_000;

type AppleFake = Partial<AppleClient>;
type GoogleFake = Partial<GoogleClient>;

function clientsOf(apple: AppleFake = {}, google: GoogleFake = {}): StoreClients {
    return {
        apple: {
            fetchApp: async (_creds, appId) => ({
                externalId: appId,
                name: `Store ${appId}`,
                bundleId: null,
                sku: `sku-${appId}`
            }),
            fetchSalesReport: async () => ({ kind: 'empty' }),
            fetchReviewsPage: async () => ({ reviews: [], next: null }),
            fetchResponse: async () => null,
            fetchVersions: async () => [],
            fetchRating: async () => null,
            ...apple
        },
        google: {
            listApps: async () => [],
            listObjects: async () => [],
            downloadObject: async () => Buffer.alloc(0),
            fetchReviews: async () => [],
            fetchReleases: async () => [],
            fetchVitals: async () => [],
            ...google
        }
    };
}

/** Une fiche déjà rattrapée : le rapport du jour suffit. */
function caughtUp(over: Partial<ListingRow> & { id: number; app_id: number }): ListingRow {
    return listingRow({
        synced_day: LATEST,
        history_from: LATEST - 364,
        state: JSON.stringify({ backfillFrom: LATEST - 364, backfillDone: true, reviewsSeeded: true, phases: {} }),
        sku: `sku-${1000 + over.app_id}`,
        ...over
    });
}

/** Une fiche à jour de toutes ses cadences : rien n'est dû tant qu'on ne le demande pas. */
function synced(appId: number): ListingRow {
    const at = Math.floor(START / 1000);
    return caughtUp({
        id: appId,
        app_id: appId,
        metrics_synced_at: at,
        reviews_synced_at: at,
        rating_synced_at: at,
        last_sync_at: at
    });
}

function setup(
    seed: { sources: SourceRow[]; listings: ListingRow[]; apps?: number[] },
    clients: StoreClients,
    options: { pausedItems?: Record<string, string[]> } = {}
) {
    const appIds = seed.apps ?? [...new Set(seed.listings.map((l) => l.app_id))];
    const repo: FakeRepo = fakeRepo({
        sources: seed.sources,
        listings: seed.listings,
        apps: appIds.map((id) => appRow({ id }))
    });
    const deps = createTestServiceDeps({ repo, manifest, pausedItems: options.pausedItems });
    let now = START;
    const sync = new AppStoresSync(deps, clients, () => now);
    return {
        repo,
        deps,
        sync,
        at: (ms: number) => {
            now = ms;
        },
        later: (ms: number) => {
            now += ms;
        },
        /** Un battement, et la fin de chaque passe qu'il lance. */
        beat: async () => {
            await deps.recorded.tickers[0].tick();
            await sync.idle();
        },
        start: async () => {
            sync.start();
            await sync.idle();
        }
    };
}

function review(id: string, rating: number, createdAt: number, over: Partial<StoreReview> = {}): StoreReview {
    return {
        externalId: id,
        rating,
        title: `Titre ${id}`,
        body: `Texte ${id}`,
        author: 'Léa',
        territory: 'FRA',
        appVersion: null,
        createdAt,
        reply: null,
        ...over
    };
}

describe('le choix des fiches dues', () => {
    it('écarte les apps en pause dans le SQL, et les revérifie avant chacune', async () => {
        const seen: string[] = [];
        const t = setup(
            {
                sources: [sourceRow({ id: 10 })],
                listings: [caughtUp({ id: 1, app_id: 1 }), caughtUp({ id: 2, app_id: 2 })]
            },
            clientsOf({
                fetchReviewsPage: async (_creds, url) => {
                    seen.push(url);
                    return { reviews: [], next: null };
                }
            }),
            { pausedItems: { apps: ['2'] } }
        );
        await t.start();
        assert.deepEqual(t.repo.db.dueCalls[0].pausedAppIds, [2]);
        assert.ok(
            seen.every((url) => url.includes('/1001/')),
            'l’app en pause n’est pas lue'
        );
        assert.equal(seen.length, 1);
        const paused = t.repo.db.listings.find((l) => l.app_id === 2);
        assert.equal(paused?.last_sync_at, null);
        assert.notEqual(t.repo.db.listings.find((l) => l.app_id === 1)?.last_sync_at, null);
    });

    it('lit un rapport par jour pour tout le compte, et le répartit entre ses apps', async () => {
        const days: number[] = [];
        const rows = (appleId: string, units: number, country: string): AppleSalesRow => ({
            appleId,
            parentId: '',
            sku: `sku-${appleId}`,
            productType: '1',
            units,
            proceeds: 0,
            currency: 'EUR',
            country
        });
        const t = setup(
            {
                sources: [sourceRow({ id: 10 })],
                listings: [
                    caughtUp({ id: 1, app_id: 1, synced_day: LATEST - 2 }),
                    caughtUp({ id: 2, app_id: 2, synced_day: LATEST - 2 })
                ]
            },
            clientsOf({
                fetchSalesReport: async (_creds, day) => {
                    days.push(day);
                    return {
                        kind: 'rows',
                        rows: [rows('1001', 4, 'FR'), rows('1002', 6, 'US'), rows('1002', 3, 'CA')]
                    };
                }
            })
        );
        await t.start();
        assert.deepEqual(days, [LATEST - 1, LATEST], 'un seul rapport par jour, pour les deux apps');
        const downloads = (appId: number) =>
            t.repo.db.daily.filter((d) => d.app_id === appId).map((d) => [d.day, d.downloads]);
        assert.deepEqual(downloads(1), [
            [LATEST - 1, 4],
            [LATEST, 4]
        ]);
        assert.deepEqual(downloads(2), [
            [LATEST - 1, 9],
            [LATEST, 9]
        ]);
        assert.deepEqual(
            t.repo.db.countries.filter((c) => c.app_id === 2 && c.day === LATEST).map((c) => [c.country, c.downloads]),
            [
                ['US', 6],
                ['CA', 3]
            ]
        );
        assert.ok(t.repo.db.listings.every((l) => l.synced_day === LATEST));
    });

    it('rattrape une fiche neuve en descendant le temps, curseur en base', async () => {
        const days: number[] = [];
        const t = setup(
            { sources: [sourceRow({ id: 10 })], listings: [listingRow({ id: 1, app_id: 1 })] },
            clientsOf({
                fetchSalesReport: async (_creds, day) => {
                    days.push(day);
                    return day === LATEST ? { kind: 'pending' } : { kind: 'empty' };
                }
            })
        );
        await t.start();
        assert.equal(days[0], LATEST);
        assert.equal(days.length, 30, 'une passe lit trente rapports au plus');
        const listing = t.repo.db.listings[0];
        assert.equal(listing.synced_day, LATEST - 1, 'le jour pas encore publié ne compte pas');
        assert.equal(listing.history_from, LATEST - 29);
        assert.equal(listing.metrics_synced_at, null, 'le rattrapage continue au battement suivant');
    });
});

describe('les pays Google', () => {
    it('se lisent dans le rapport par pays, à côté des installations', async () => {
        const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
        const files: Record<string, Buffer> = {
            'stats/installs/installs_com.exemple.app1_202611_overview.csv': utf16(
                'Date,Daily User Installs\n2026-11-14,12'
            ),
            'stats/installs/installs_com.exemple.app1_202611_country.csv': utf16(
                'Date,Country,Daily User Installs\n2026-11-14,FR,9\n2026-11-14,BE,3\n2026-11-14,DE,0'
            )
        };
        const t = setup(
            {
                sources: [
                    sourceRow({
                        id: 20,
                        store: 'google',
                        capabilities: 'downloads',
                        content: JSON.stringify({
                            label: 'Play',
                            clientEmail: 'deveye@projet.iam.gserviceaccount.com',
                            bucket: 'pubsite_prod_rev_0123'
                        })
                    })
                ],
                listings: [caughtUp({ id: 1, app_id: 1, store: 'google', source_id: 20 })]
            },
            clientsOf(
                {},
                {
                    listObjects: async (_creds, prefix) =>
                        Object.keys(files)
                            .filter((name) => name.startsWith(prefix))
                            .map((name) => ({ name, etag: 'e1' })),
                    downloadObject: async (_creds, name) => files[name]
                }
            )
        );
        await t.start();
        assert.deepEqual(
            t.repo.db.countries.map((c) => [c.store, c.country, c.downloads]),
            [
                ['google', 'FR', 9],
                ['google', 'BE', 3]
            ]
        );
        assert.equal(t.repo.db.daily[0]?.downloads, 12);
    });
});

describe('le repli d’une source', () => {
    it('attend le Retry-After d’un 429, puis double à chaque échec', async () => {
        let calls = 0;
        const t = setup(
            { sources: [sourceRow({ id: 10 })], listings: [caughtUp({ id: 1, app_id: 1, synced_day: LATEST - 1 })] },
            clientsOf({
                fetchSalesReport: async () => {
                    calls += 1;
                    throw new StoreError('apple', 429, { retryAt: Math.floor(START / 1000) + 600 });
                }
            })
        );
        await t.start();
        assert.equal(calls, 1);
        t.later(120_000);
        await t.beat();
        assert.ok(t.repo.db.dueCalls.at(-1)?.skipSourceIds.includes(10), 'la source en repli est écartée');
        assert.equal(calls, 1);
        t.at(START + 601_000);
        await t.beat();
        assert.equal(calls, 2);
        t.later(100_000);
        await t.beat();
        assert.equal(calls, 2, 'le second échec double le repli : 120 s');
        t.later(30_000);
        await t.beat();
        assert.equal(calls, 3);
    });
});

describe('une clé refusée', () => {
    it('est dite perdue au troisième refus, une seule fois, puis rétablie une seule fois', async () => {
        let refuse = true;
        const t = setup(
            {
                sources: [sourceRow({ id: 10 })],
                listings: [
                    caughtUp({ id: 1, app_id: 1, synced_day: LATEST - 1 }),
                    caughtUp({ id: 2, app_id: 2, synced_day: LATEST - 1 })
                ]
            },
            clientsOf({
                fetchSalesReport: async () => {
                    if (refuse) throw new StoreError('apple', 401);
                    return { kind: 'empty' };
                }
            })
        );
        const lost = () => t.deps.recorded.notifications.filter((n) => n.subject.includes('est refusée'));
        const restored = () => t.deps.recorded.notifications.filter((n) => n.subject.includes('de nouveau acceptée'));

        await t.start();
        assert.equal(t.repo.db.sources[0].failing_count, 1);
        assert.equal(lost().length, 0, 'un refus isolé ne prévient personne');
        for (let round = 0; round < 3; round++) {
            t.later(1000_000);
            await t.beat();
        }
        assert.equal(t.repo.db.sources[0].failing_count, 4);
        assert.equal(lost().length, 1);
        assert.deepEqual(lost()[0].itemIds, [1, 2], 'vers les canaux de toutes les apps de la source');
        assert.match(lost()[0].body, /Source 10/);
        assert.equal(t.repo.db.sources[0].failing_notified, 1);
        assert.ok(
            t.repo.db.listings.every((l) => l.sync_error?.includes('refuse la clé')),
            'chaque fiche dit pourquoi'
        );

        refuse = false;
        t.later(1000_000);
        await t.beat();
        assert.equal(restored().length, 1);
        assert.deepEqual(restored()[0].itemIds, [1, 2]);
        assert.equal(t.repo.db.sources[0].failing_count, 0);
        t.later(7 * HOUR);
        await t.beat();
        assert.equal(restored().length, 1, 'le retour ne se dit qu’une fois');
        assert.equal(lost().length, 1);
    });

    it('ne dit pas rétablie une perte jamais annoncée', async () => {
        let refuse = true;
        const t = setup(
            { sources: [sourceRow({ id: 10 })], listings: [caughtUp({ id: 1, app_id: 1, synced_day: LATEST - 1 })] },
            clientsOf({
                fetchSalesReport: async () => {
                    if (refuse) throw new StoreError('apple', 401);
                    return { kind: 'empty' };
                }
            })
        );
        await t.start();
        refuse = false;
        t.later(1000_000);
        await t.beat();
        assert.equal(t.repo.db.sources[0].failing_count, 0);
        assert.equal(t.deps.recorded.notifications.length, 0);
    });
});

describe('les avis', () => {
    it('se taisent au premier passage, puis partent groupés en un avis par app', async () => {
        const now = Math.floor(START / 1000);
        let page: StoreReview[] = [
            review('a-1', 5, now - 300),
            review('a-2', 4, now - 400),
            review('a-3', 1, now - 500)
        ];
        const t = setup(
            {
                sources: [sourceRow({ id: 10 })],
                listings: [
                    caughtUp({
                        id: 1,
                        app_id: 1,
                        state: JSON.stringify({ backfillFrom: LATEST - 364, backfillDone: true })
                    })
                ]
            },
            clientsOf({ fetchReviewsPage: async () => ({ reviews: page, next: null }) })
        );
        await t.start();
        assert.equal(t.repo.db.reviews.length, 3);
        assert.equal(t.deps.recorded.notifications.length, 0, 'le rattrapage ne prévient pas');

        page = [review('a-5', 2, now + 60), review('a-4', 3, now + 30), ...page];
        t.later(31 * 60_000);
        await t.beat();
        const notices = t.deps.recorded.notifications;
        assert.equal(notices.length, 1);
        assert.equal(notices[0].itemId, 1);
        assert.equal(notices[0].subject, '[DevEye] 2 nouveaux avis sur App 1');
        assert.match(notices[0].body, /note la plus basse : 2 étoiles/);
        assert.doesNotMatch(notices[0].body, /€|EUR/);

        t.later(31 * 60_000);
        await t.beat();
        assert.equal(t.deps.recorded.notifications.length, 1, 'rien de neuf, rien d’envoyé');
    });

    it('met à jour une réponse qu’Apple vient de publier', async () => {
        const now = Math.floor(START / 1000);
        const pending = review('a-1', 2, now - 300, {
            reply: { body: 'Merci', at: now - 200, state: 'pending', responseId: 'r-1' }
        });
        let page = [pending];
        const t = setup(
            {
                sources: [sourceRow({ id: 10 })],
                listings: [
                    caughtUp({
                        id: 1,
                        app_id: 1,
                        state: JSON.stringify({ backfillFrom: LATEST - 364, backfillDone: true })
                    })
                ]
            },
            clientsOf({ fetchReviewsPage: async () => ({ reviews: page, next: null }) })
        );
        await t.start();
        page = [{ ...pending, reply: { ...pending.reply!, state: 'published' } }];
        t.later(31 * 60_000);
        await t.beat();
        const stored = JSON.parse(t.repo.db.reviews[0].content) as { reply: { state: string } };
        assert.equal(stored.reply.state, 'published');
        assert.equal(t.deps.recorded.notifications.length, 0, 'un avis connu ne se renvoie pas');
    });
});

describe('les versions Apple', () => {
    it('ne préviennent qu’aux étapes utiles, et pas à la première lecture', async () => {
        let state = 'PREPARE_FOR_SUBMISSION';
        const t = setup(
            {
                sources: [sourceRow({ id: 10 })],
                listings: [
                    caughtUp({
                        id: 1,
                        app_id: 1,
                        state: JSON.stringify({ backfillFrom: LATEST - 364, backfillDone: true, reviewsSeeded: true })
                    })
                ]
            },
            clientsOf({ fetchVersions: async () => [{ id: 'v-1', version: '2.0', state, createdAt: 1 }] })
        );
        const subjects = () => t.deps.recorded.notifications.map((n) => n.subject);
        state = 'WAITING_FOR_REVIEW';
        await t.start();
        assert.deepEqual(subjects(), [], 'la première lecture ne fait que noter');
        state = 'IN_REVIEW';
        t.later(31 * 60_000);
        await t.beat();
        assert.deepEqual(subjects(), ['[DevEye] App 1 2.0 : en revue']);
        t.later(31 * 60_000);
        await t.beat();
        assert.equal(subjects().length, 1, 'un état inchangé ne se redit pas');
        state = 'PENDING_DEVELOPER_RELEASE';
        t.later(31 * 60_000);
        await t.beat();
        state = 'READY_FOR_DISTRIBUTION';
        t.later(31 * 60_000);
        await t.beat();
        assert.deepEqual(subjects().slice(1), ['[DevEye] App 1 2.0 : acceptée', '[DevEye] App 1 2.0 : en production']);
        const listing = JSON.parse(t.repo.db.listings[0].state ?? '{}') as { versions: { state: string }[] };
        assert.equal(listing.versions[0].state, 'READY_FOR_DISTRIBUTION');
    });
});

describe('les versions Google', () => {
    it('gardent de mémoire celles que Google ne rend plus, sans prévenir de leurs étapes', async () => {
        let releases = [{ version: '4.3.5', state: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', code: 435 }];
        const t = setup(
            {
                sources: [
                    sourceRow({
                        id: 20,
                        store: 'google',
                        capabilities: 'versions',
                        content: JSON.stringify({
                            label: 'Play',
                            clientEmail: 'deveye@projet.iam.gserviceaccount.com',
                            bucket: 'pubsite_prod_rev_0123'
                        })
                    })
                ],
                listings: [caughtUp({ id: 1, app_id: 1, store: 'google', source_id: 20 })]
            },
            clientsOf({}, { fetchReleases: async () => releases })
        );
        const stored = () =>
            (
                JSON.parse(t.repo.db.listings[0].state ?? '{}') as { versions: { version: string; state: string }[] }
            ).versions.map((v) => [v.version, v.state]);
        await t.start();
        assert.deepEqual(stored(), [['4.3.5', 'RELEASE_LIFECYCLE_STATE_PUBLISHED']]);
        releases = [{ version: '4.3.6', state: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', code: 436 }];
        t.later(31 * 60_000);
        await t.beat();
        assert.deepEqual(stored(), [
            ['4.3.6', 'RELEASE_LIFECYCLE_STATE_PUBLISHED'],
            ['4.3.5', 'RELEASE_LIFECYCLE_STATE_PUBLISHED']
        ]);
        assert.deepEqual(t.deps.recorded.notifications, []);
    });
});

describe('la stabilité Google', () => {
    it('prévient quand la moyenne sur 28 jours franchit le seuil, dans un sens puis dans l’autre', async () => {
        let rate = 0.02;
        const vitals = (): VitalsDay[] =>
            Array.from({ length: 30 }, (_, i) => ({ day: LATEST - i, crashRate: rate, anrRate: 0.001, users: 100 }));
        const t = setup(
            {
                sources: [
                    sourceRow({
                        id: 20,
                        store: 'google',
                        capabilities: 'vitals',
                        content: JSON.stringify({
                            label: 'Play',
                            clientEmail: 'deveye@projet.iam.gserviceaccount.com',
                            bucket: 'pubsite_prod_rev_0123'
                        })
                    })
                ],
                listings: [caughtUp({ id: 1, app_id: 1, store: 'google', source_id: 20 })]
            },
            clientsOf({}, { fetchVitals: async () => vitals() })
        );
        const subjects = () => t.deps.recorded.notifications.map((n) => n.subject);
        await t.start();
        assert.deepEqual(subjects(), [], 'la première mesure fixe l’état sans prévenir');
        rate = 0.005;
        t.later(7 * HOUR);
        await t.beat();
        assert.deepEqual(subjects(), ['[DevEye] App 1 : plantages repassés sous le seuil de Google Play']);
        rate = 0.03;
        t.later(7 * HOUR);
        await t.beat();
        assert.equal(subjects()[1], '[DevEye] App 1 : plantages au-dessus du seuil de Google Play');
        assert.equal(subjects().length, 2, 'le taux d’ANR reste sous son seuil');
        const day = t.repo.db.daily.find((d) => d.day === LATEST);
        assert.equal(day?.crash_rate, 0.03);
        assert.equal(day?.vitals_users, 100);
    });
});

describe('l’arrêt', () => {
    it('attend chaque passe en vol, l’interrompt, et repart au démarrage suivant', async () => {
        let started = 0;
        let signal: AbortSignal | undefined;
        let arrived: () => void = () => undefined;
        const inFlight = new Promise<void>((resolve) => {
            arrived = resolve;
        });
        const t = setup(
            { sources: [sourceRow({ id: 10 })], listings: [caughtUp({ id: 1, app_id: 1, synced_day: LATEST - 1 })] },
            clientsOf({
                fetchSalesReport: (_creds, _day, abort) => {
                    started += 1;
                    if (started > 1) return Promise.resolve({ kind: 'empty' });
                    signal = abort;
                    arrived();
                    return new Promise((_resolve, reject) => {
                        abort?.addEventListener('abort', () =>
                            reject(Object.assign(new Error('Interrompu'), { name: 'AbortError' }))
                        );
                    });
                }
            })
        );
        t.sync.start();
        await inFlight;
        let stopped = false;
        const stopping = t.sync.stop().then(() => {
            stopped = true;
        });
        await stopping;
        assert.ok(stopped);
        assert.equal(signal?.aborted, true);
        assert.notEqual(t.repo.db.listings[0].last_sync_at, null, 'la passe a écrit avant de rendre la main');
        assert.equal(t.repo.db.sources[0].failing_count, 0, 'un arrêt n’est pas un refus');

        t.sync.start();
        await t.sync.idle();
        assert.equal(started, 2, 'un second démarrage relance une passe');
        await t.sync.stop();
    });
});

describe('la relecture demandée', () => {
    it('ouvre une opération et la solde à la fin de la première passe', async () => {
        const t = setup({ sources: [sourceRow({ id: 10 })], listings: [synced(1)] }, clientsOf());
        await t.start();
        assert.equal(t.repo.db.calls.filter((c) => c === 'listListingsOfSource').length, 0, 'rien n’était dû');
        t.sync.requestBackfill(1, { userId: 7, workspaceId: 1, subject: 'App 1' });
        await t.sync.idle();
        const [task] = t.deps.recorded.tasks;
        assert.equal(task.title, 'Relecture de l’année écoulée');
        assert.equal(task.key, 'sync');
        assert.equal(task.itemId, 1);
        assert.deepEqual(task.outcome, {
            state: 'done',
            note: 'Relecture lancée : les mois restants se complètent d’eux-mêmes en quelques minutes.'
        });
    });

    it('dit l’échec d’une clé refusée, en conflit', async () => {
        const t = setup(
            { sources: [sourceRow({ id: 10 })], listings: [synced(1)] },
            clientsOf({
                fetchReviewsPage: async () => {
                    throw new StoreError('apple', 401);
                }
            })
        );
        await t.start();
        t.sync.requestBackfill(1, { userId: 7, workspaceId: 1, subject: 'App 1' });
        await t.sync.idle();
        const [task] = t.deps.recorded.tasks;
        assert.equal(task.outcome?.state, 'failed');
        assert.ok(task.outcome?.state === 'failed' && task.outcome.code === 'conflict');
        assert.ok(task.outcome?.state === 'failed' && /refuse la clé/.test(task.outcome.message));
    });
});

describe('la relecture de l’année', () => {
    it('relit les rapports Apple du dernier jour relevé vers le passé, sans faire reculer la couverture', async () => {
        const days: number[] = [];
        const t = setup(
            { sources: [sourceRow({ id: 10 })], listings: [synced(1)] },
            clientsOf({
                fetchSalesReport: async (_creds, day) => {
                    days.push(day);
                    return { kind: 'empty' };
                }
            })
        );
        await t.start();
        assert.deepEqual(days, [], 'rien n’était dû');
        const before = t.deps.recorded.liveChanges.length;
        t.sync.requestBackfill(1, { userId: 7, workspaceId: 1, subject: 'App 1' });
        await t.sync.idle();
        assert.ok(t.deps.recorded.liveChanges.length > before, 'les écrans voient la relecture partir');
        assert.equal(days.length, 30, 'une passe lit trente rapports au plus');
        assert.equal(days[0], LATEST);
        const listing = () => t.repo.db.listings[0];
        assert.equal(listing().history_from, LATEST - 364, 'la couverture reste entière');
        assert.equal(listing().metrics_synced_at, null, 'le rattrapage continue au battement suivant');
        assert.equal(t.deps.recorded.tasks[0].title, 'Relecture de l’année écoulée');
        assert.equal(t.deps.recorded.tasks[0].outcome?.state, 'done');

        let beforeLast = 0;
        for (let beat = 0; beat < 12 && listing().metrics_synced_at === null; beat++) {
            t.later(60_000);
            beforeLast = t.deps.recorded.liveChanges.length;
            await t.beat();
        }
        assert.ok(t.deps.recorded.liveChanges.length > beforeLast, 'les écrans voient la relecture finir');
        assert.equal(days.length, 365, 'un an, chaque jour une fois');
        assert.equal(Math.min(...days), LATEST - 364);
        assert.notEqual(listing().metrics_synced_at, null, 'rattrapage fini, la cadence reprend');
        assert.equal(listing().history_from, LATEST - 364);
    });

    it('relit les mois Google, même ceux dont l’etag n’a pas bougé', async () => {
        const read: string[] = [];
        const t = setup(
            {
                sources: [
                    sourceRow({
                        id: 20,
                        store: 'google',
                        capabilities: 'downloads',
                        content: JSON.stringify({
                            label: 'Play',
                            clientEmail: 'deveye@projet.iam.gserviceaccount.com',
                            bucket: 'pubsite_prod_rev_0123'
                        })
                    })
                ],
                listings: [
                    caughtUp({
                        id: 1,
                        app_id: 1,
                        store: 'google',
                        source_id: 20,
                        metrics_synced_at: Math.floor(START / 1000),
                        reviews_synced_at: Math.floor(START / 1000)
                    })
                ]
            },
            clientsOf(
                {},
                {
                    listObjects: async (_creds, prefix) =>
                        ['202610', '202611'].flatMap((month) =>
                            [`${prefix}${month}_overview.csv`, `${prefix}${month}_country.csv`].map((name) => ({
                                name,
                                etag: 'e1'
                            }))
                        ),
                    downloadObject: async (_creds, name) => {
                        read.push(name);
                        return Buffer.concat([
                            Buffer.from([0xff, 0xfe]),
                            Buffer.from('Date,Country,Daily User Installs\n', 'utf16le')
                        ]);
                    }
                }
            )
        );
        await t.start();
        t.repo.db.listings[0].state = JSON.stringify({
            backfillDone: true,
            etags: Object.fromEntries(
                ['202610', '202611'].flatMap((month) =>
                    ['overview', 'country'].map((kind) => [
                        `stats/installs/installs_com.exemple.app1_${month}_${kind}.csv`,
                        'e1'
                    ])
                )
            )
        });
        t.sync.requestBackfill(1, null);
        await t.sync.idle();
        assert.deepEqual(read.sort(), [
            'stats/installs/installs_com.exemple.app1_202610_country.csv',
            'stats/installs/installs_com.exemple.app1_202610_overview.csv',
            'stats/installs/installs_com.exemple.app1_202611_country.csv',
            'stats/installs/installs_com.exemple.app1_202611_overview.csv'
        ]);
        assert.notEqual(t.repo.db.listings[0].metrics_synced_at, null, 'tout est relu en une passe');
    });
});

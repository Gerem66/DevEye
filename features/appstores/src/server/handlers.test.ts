import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    appStoresAdd,
    appStoresAddSource,
    appStoresBackfill,
    appStoresCommands,
    appStoresList,
    appStoresListSources,
    appStoresOverview,
    appStoresRemove,
    appStoresReplyReview,
    appStoresRevenue,
    appStoresStats,
    appStoresUpdate,
    appStoresUpdateSource
} from '../contracts/commands';
import { manifest } from '../manifest';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, type TestContextOverrides } from '@deveye/types/sdk/testing';

import { utcToday } from './days';
import { appStoresHandlers } from './handlers';
import type { AppStoresRepo, ListingRow } from './repo';
import { forgetAppleTokens } from './stores/apple';
import { storeHttp, type StoreFetch } from './stores/types';
import { appRow, fakeRepo, listingRow, sourceRow, type DailyCell, type FakeRepo } from './_testing';
import { reviewRef, toSource } from './_shared';

/**
 * Les commandes de Stores, sur le harnais du SDK. Le dispatcheur n'y tourne
 * pas : les droits se lisent sur les déclarations, la frontière d'espace et
 * le domicile dans les handlers. On tient ce qu'aucune erreur ne signalerait :
 * aucun montant hors de la commande des revenus, l'app d'une réponse déduite
 * de l'avis, un secret qui ne ressort jamais.
 */

type Ctx = SdkFeatureContext<AppStoresRepo>;

function definitionOf(command: string) {
    const def = appStoresHandlers.find((h) => h.command === command);
    assert.ok(def, `handler ${command} manquant`);
    return def;
}

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    return definitionOf(contract.command).handler as (
        ctx: Ctx,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code'], message?: RegExp) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code && (!message || message.test(e.message));

function contextOf(repo: FakeRepo, over: TestContextOverrides<AppStoresRepo> = {}) {
    return createTestContext<AppStoresRepo>({ repo, manifest, ...over });
}

const TODAY = utcToday(Date.now());
const UNTIL = TODAY - 2;

/** Une fiche qui couvre l'année jusqu'à `UNTIL`. */
function covered(over: Partial<ListingRow> & { id: number; app_id: number; externalId?: string }): ListingRow {
    return listingRow({ synced_day: UNTIL, history_from: UNTIL - 400, ...over });
}

const original = storeHttp.fetch;
let calls: string[] = [];

function answer(route: (url: URL, init: RequestInit) => Response): void {
    storeHttp.fetch = (async (url, init) => {
        calls.push(`${init.method ?? 'GET'} ${url}`);
        return route(new URL(url), init);
    }) as StoreFetch;
}

function noNetwork(): void {
    storeHttp.fetch = (async (url) => {
        throw new Error(`aucun appel attendu : ${url}`);
    }) as StoreFetch;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
    calls = [];
    forgetAppleTokens();
});

afterEach(() => {
    storeHttp.fetch = original;
});

describe('les droits déclarés', () => {
    const expected: Record<string, { level?: string; item?: string | 'finder'; extras?: string[]; mutates?: true }> = {
        'appstores.listSources': { level: 'write' },
        'appstores.listStoreApps': { level: 'write' },
        'appstores.addSource': { level: 'write', mutates: true },
        'appstores.updateSource': { level: 'write', mutates: true },
        'appstores.removeSource': { level: 'write', mutates: true },
        'appstores.testSource': { level: 'write', mutates: true },
        'appstores.count': {},
        'appstores.list': {},
        'appstores.get': { item: 'appId' },
        'appstores.stats': { item: 'appId' },
        'appstores.listReviews': { item: 'appId' },
        'appstores.add': { level: 'write', mutates: true },
        'appstores.update': { level: 'write', item: 'appId', mutates: true },
        'appstores.remove': { level: 'write', item: 'appId', mutates: true },
        'appstores.backfill': { level: 'write', item: 'appId' },
        'appstores.syncNow': { level: 'write', item: 'appId' },
        'appstores.overview': {},
        'appstores.replyReview': { level: 'write', item: 'finder', mutates: true },
        'appstores.revenue': { extras: ['revenue'], item: 'appId' }
    };

    it('donne à chaque commande son accès et son sujet, ni plus ni moins', () => {
        assert.deepEqual(
            appStoresHandlers.map((h) => h.command).sort(),
            appStoresCommands.map((c) => c.command).sort()
        );
        for (const [command, want] of Object.entries(expected)) {
            const def = definitionOf(command);
            const item = def.access?.item;
            assert.equal(def.access?.level, want.level, `${command} : niveau`);
            assert.equal(typeof item === 'function' ? 'finder' : item, want.item, `${command} : élément`);
            assert.deepEqual(def.access?.extras, want.extras, `${command} : permissions propres`);
            assert.equal(def.mutates, want.mutates, `${command} : mutates`);
        }
    });

    it('déclare Revenus en interrupteur, la seule permission propre', () => {
        assert.deepEqual(
            (manifest.extraPermissions ?? []).map((extra) => [extra.key, extra.type]),
            [['revenue', 'toggle']]
        );
    });
});

describe('les chiffres', () => {
    function seeded() {
        const repo = fakeRepo({
            sources: [sourceRow({ id: 10 }), sourceRow({ id: 20, store: 'google' })],
            apps: [appRow({ id: 1 })],
            listings: [
                covered({ id: 1, app_id: 1, store: 'apple' }),
                covered({
                    id: 2,
                    app_id: 1,
                    store: 'google',
                    source_id: 20,
                    synced_day: UNTIL - 1,
                    history_from: UNTIL - 59
                })
            ],
            daily: [UNTIL - 1, UNTIL - 2, UNTIL - 40].flatMap((day) => [
                {
                    app_id: 1,
                    store: 'apple' as const,
                    day,
                    downloads: 10,
                    updates: null,
                    uninstalls: null,
                    active_devices: null,
                    rating_avg: 4.5,
                    rating_count: 100,
                    crash_rate: null,
                    anr_rate: null,
                    vitals_users: null
                },
                {
                    app_id: 1,
                    store: 'google' as const,
                    day,
                    downloads: 5,
                    updates: null,
                    uninstalls: null,
                    active_devices: null,
                    rating_avg: 4.1,
                    rating_count: null,
                    crash_rate: 0.01,
                    anr_rate: 0.002,
                    vitals_users: 100
                }
            ]),
            revenue: [
                { app_id: 1, store: 'apple', day: UNTIL - 1, currency: 'EUR', amount: 12.5, units: 3 },
                { app_id: 1, store: 'google', day: UNTIL - 2, currency: 'USD', amount: 4.99, units: 1 },
                { app_id: 1, store: 'apple', day: UNTIL - 40, currency: 'EUR', amount: 2, units: 1 }
            ],
            countries: [
                { app_id: 1, store: 'apple', day: UNTIL, country: 'DE', downloads: 7 },
                { app_id: 1, store: 'apple', day: UNTIL - 1, country: 'US', downloads: 4 },
                { app_id: 1, store: 'apple', day: UNTIL - 1, country: 'FR', downloads: 6 },
                { app_id: 1, store: 'google', day: UNTIL - 2, country: 'FR', downloads: 5 },
                { app_id: 1, store: 'apple', day: UNTIL - 40, country: 'FR', downloads: 100 }
            ],
            reviews: [
                {
                    id: 1,
                    app_id: 1,
                    store: 'apple',
                    external_ref: 'r1',
                    rating: 2,
                    created_at: (UNTIL - 1) * 86400,
                    replied_at: null,
                    content: '{}'
                }
            ]
        });
        return repo;
    }

    it('ne rendent aucun montant, et ne lisent même pas les revenus', async () => {
        const repo = seeded();
        const { stats } = await handlerFor(appStoresStats)(contextOf(repo), { appId: 1, range: '30d' });
        const text = JSON.stringify(stats);
        for (const word of ['amount', 'currency', 'EUR', 'USD', '12.5', '4.99', 'units']) {
            assert.ok(!text.includes(word), `aucun « ${word} » dans les chiffres`);
        }
        assert.ok(!repo.db.calls.includes('revenueRows'));
    });

    it('finissent au dernier jour commun aux stores, et taisent un écart que la période précédente ne couvre pas', async () => {
        const { stats } = await handlerFor(appStoresStats)(contextOf(seeded()), { appId: 1, range: '30d' });
        assert.equal(stats.dataUntil, (UNTIL - 1) * 86400, 'Google a un jour de retard sur Apple');
        assert.equal(stats.to, UNTIL * 86400);
        assert.equal(stats.from, (UNTIL - 30) * 86400);
        assert.equal(stats.points.length, 30);
        assert.equal(stats.previousPoints.length, 30, 'la période d’avant, seau par seau');
        assert.equal(stats.previousPoints[29].at, (UNTIL - 31) * 86400);
        assert.deepEqual(stats.metrics.downloads, { apple: 20, google: 10 });
        assert.deepEqual(stats.previous.downloads, { apple: 10, google: 5 });
        assert.equal(stats.previousCovered, false, 'Google ne remonte pas jusqu’au début de la période précédente');
        assert.equal(stats.metrics.rating.apple, 4.5);
        assert.equal(stats.metrics.reviews, 1);
        assert.deepEqual(stats.reviewStars, [0, 1, 0, 0, 0]);
        assert.equal(stats.metrics.crashRate, 0.01);
        assert.deepEqual(
            stats.countries,
            [
                { country: 'FR', downloads: 11 },
                { country: 'US', downloads: 4 }
            ],
            'les deux stores sommés, sur la seule période'
        );
    });

    it('prennent la note Apple relevée après une fenêtre que Google arrête plus tôt, sans écart inventé', async () => {
        const repo = seeded();
        for (const cell of repo.db.daily) if (cell.store === 'apple') cell.rating_avg = null;
        repo.db.daily.push({
            app_id: 1,
            store: 'apple',
            day: UNTIL,
            downloads: null,
            updates: null,
            uninstalls: null,
            active_devices: null,
            rating_avg: 4.7,
            rating_count: 102,
            crash_rate: null,
            anr_rate: null,
            vitals_users: null
        });
        const { stats } = await handlerFor(appStoresStats)(contextOf(repo), { appId: 1, range: '30d' });
        assert.equal(stats.to, UNTIL * 86400, 'la fenêtre finit la veille du relevé de la note');
        assert.equal(stats.metrics.rating.apple, 4.7);
        assert.equal(stats.previous.rating.apple, null);
    });

    it('restreints à un store, finissent à son propre dernier jour et ne comptent que ses avis', async () => {
        const { stats } = await handlerFor(appStoresStats)(contextOf(seeded()), {
            appId: 1,
            range: '30d',
            store: 'google'
        });
        assert.equal(stats.dataUntil, (UNTIL - 1) * 86400);
        assert.deepEqual(stats.metrics.downloads, { apple: null, google: 10 });
        assert.equal(stats.metrics.reviews, 0, 'le seul avis est sur l’App Store');
        assert.deepEqual(stats.reviewStars, [0, 0, 0, 0, 0]);
        assert.deepEqual(stats.countries, [{ country: 'FR', downloads: 5 }]);

        const { revenue } = await handlerFor(appStoresRevenue)(contextOf(seeded(), { extras: { revenue: true } }), {
            appId: 1,
            range: '30d',
            store: 'apple'
        });
        assert.deepEqual(
            revenue.totals.map((t) => [t.store, t.currency]),
            [['apple', 'EUR']]
        );
    });

    it('comptent par semaine sur l’année', async () => {
        const { stats } = await handlerFor(appStoresStats)(contextOf(seeded()), { appId: 1, range: '365d' });
        assert.equal(stats.resolution, 'week');
        assert.equal(stats.bucket, 7 * 86400);
        assert.equal(stats.points.length, 52);
    });

    it('rendent les revenus par store et par devise, sans écart là où la fiche ne couvre pas', async () => {
        const { revenue } = await handlerFor(appStoresRevenue)(contextOf(seeded(), { extras: { revenue: true } }), {
            appId: 1,
            range: '30d'
        });
        assert.deepEqual(
            revenue.totals.map((t) => [t.store, t.currency, t.amount, t.previous, t.units]),
            [
                ['apple', 'EUR', 12.5, 2, 3],
                ['google', 'USD', 4.99, null, 1]
            ]
        );
        assert.equal(revenue.points.length, 2 * 30, 'une série pleine par store et par devise');
    });
});

describe('la réponse à un avis', () => {
    const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
    });

    function seeded(over: { appWorkspace?: number } = {}) {
        const review = (id: number, store: 'apple' | 'google', externalId: string) => ({
            id,
            app_id: store === 'apple' ? 1 : 2,
            store,
            external_ref: reviewRef(createTestContext().keys, store === 'apple' ? 1 : 2, store, externalId),
            rating: 2,
            created_at: 1_700_000_000,
            replied_at: null,
            content: JSON.stringify({
                externalId,
                title: 'Bof',
                body: 'Plante',
                author: 'Léa',
                territory: null,
                appVersion: null,
                reply: null
            })
        });
        return fakeRepo({
            sources: [sourceRow({ id: 10, secret_enc: privateKey }), sourceRow({ id: 20, store: 'google' })],
            apps: [appRow({ id: 1, workspace_id: over.appWorkspace ?? 1 }), appRow({ id: 2 })],
            listings: [
                listingRow({ id: 1, app_id: 1, workspace_id: over.appWorkspace ?? 1 }),
                listingRow({ id: 2, app_id: 2, store: 'google', source_id: 20 })
            ],
            reviews: [review(7, 'apple', 'aaaa-1111'), review(8, 'google', 'gp:AOqp1')],
            shares: over.appWorkspace ? [{ appId: 1, workspaceId: 1 }] : []
        });
    }

    it('trouve l’app par l’avis, jamais par un identifiant à part', async () => {
        const repo = seeded();
        const finder = definitionOf('appstores.replyReview').access?.item;
        assert.equal(typeof finder, 'function');
        const find = finder as (ctx: Ctx, input: { reviewId: number }) => Promise<unknown>;
        assert.equal(await find(contextOf(repo), { reviewId: 7 }), 1);
        assert.equal(await find(contextOf(repo), { reviewId: 8 }), 2);
        assert.equal(await find(contextOf(repo), { reviewId: 99 }), undefined);
    });

    it('publie chez Apple, garde la réponse en attente de relecture, et l’audite', async () => {
        answer((url) =>
            url.pathname === '/v1/customerReviewResponses'
                ? json(
                      {
                          data: {
                              type: 'customerReviewResponses',
                              id: 'resp-9',
                              attributes: { responseBody: 'Merci !', state: 'PENDING_PUBLISH' }
                          }
                      },
                      201
                  )
                : json({}, 404)
        );
        const repo = seeded();
        const ctx = contextOf(repo);
        const { review } = await handlerFor(appStoresReplyReview)(ctx, { reviewId: 7, body: 'Merci !' });
        assert.deepEqual(review.reply?.state, 'pending');
        assert.equal(review.reply?.body, 'Merci !');
        const stored = JSON.parse(repo.db.reviews[0].content) as { reply: { responseId: string } };
        assert.equal(stored.reply.responseId, 'resp-9', 'de quoi la remplacer plus tard');
        assert.notEqual(repo.db.reviews[0].replied_at, null);
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['appstores.replyReview']
        );
    });

    it('ne part que de chez l’app : une fenêtre projetée lit, elle ne répond pas', async () => {
        noNetwork();
        const repo = seeded({ appWorkspace: 2 });
        await assert.rejects(
            handlerFor(appStoresReplyReview)(contextOf(repo, { shares: { '1': 2 } }), { reviewId: 7, body: 'Merci' }),
            failsWith('validation', /autre espace/)
        );
    });

    it('exige l’écriture sur l’app, et une app active', async () => {
        noNetwork();
        await assert.rejects(
            handlerFor(appStoresReplyReview)(contextOf(seeded(), { itemRestrictions: { '1': 'read' } }), {
                reviewId: 7,
                body: 'Merci'
            }),
            failsWith('forbidden')
        );
        await assert.rejects(
            handlerFor(appStoresReplyReview)(contextOf(seeded(), { pausedItems: { apps: ['1'] } }), {
                reviewId: 7,
                body: 'Merci'
            }),
            failsWith('quota_exceeded')
        );
    });

    it('tient la limite du store, et dit le rôle qui manque sur un refus', async () => {
        noNetwork();
        await assert.rejects(
            handlerFor(appStoresReplyReview)(contextOf(seeded()), { reviewId: 8, body: 'x'.repeat(351) }),
            failsWith('validation', /350 caractères/)
        );
        answer(() => json({ errors: [{ status: '403' }] }, 403));
        await assert.rejects(
            handlerFor(appStoresReplyReview)(contextOf(seeded()), { reviewId: 7, body: 'Merci' }),
            failsWith('conflict', /rôle Admin/)
        );
    });
});

describe('les apps', () => {
    it('refusent l’app de trop, comptée sur l’offre du propriétaire', async () => {
        const repo = fakeRepo({ apps: [appRow({ id: 1 })] });
        await assert.rejects(
            handlerFor(appStoresAdd)(contextOf(repo, { quotaLimits: { apps: 1 } }), {
                name: 'Deuxième',
                ratingCountry: 'FR',
                apple: null,
                google: null
            }),
            failsWith('quota_exceeded')
        );
        assert.equal(repo.db.apps.length, 1);
    });

    it('refusent une app du store déjà suivie dans l’espace, un identifiant invalide, la source d’un autre store', async () => {
        const repo = fakeRepo({
            sources: [
                sourceRow({ id: 10 }),
                sourceRow({ id: 20, store: 'google' }),
                sourceRow({ id: 30, workspace_id: 2 })
            ],
            apps: [appRow({ id: 1 })],
            listings: [listingRow({ id: 1, app_id: 1, externalId: '1234567890' })]
        });
        const add = (apple: { sourceId: number | null; externalId: string }) =>
            handlerFor(appStoresAdd)(contextOf(repo), { name: 'Autre', ratingCountry: 'FR', apple, google: null });
        await assert.rejects(add({ sourceId: 10, externalId: '1234567890' }), failsWith('conflict', /déjà suivie/));
        await assert.rejects(add({ sourceId: 10, externalId: 'com.exemple' }), failsWith('validation'));
        await assert.rejects(add({ sourceId: 20, externalId: '42' }), failsWith('validation', /App Store/));
        await assert.rejects(add({ sourceId: 30, externalId: '42' }), failsWith('not_found'));
        assert.equal(repo.db.apps.length, 1, 'aucune app à moitié créée');
    });

    it('naissent sans store, et l’ajout est audité', async () => {
        const repo = fakeRepo();
        const ctx = contextOf(repo);
        const { app } = await handlerFor(appStoresAdd)(ctx, {
            name: 'Bientôt',
            ratingCountry: 'FR',
            apple: null,
            google: { sourceId: null, externalId: 'com.exemple.bientot' }
        });
        assert.equal(app.name, 'Bientôt');
        assert.deepEqual(
            app.listings.map((l) => [l.store, l.externalId, l.sourceId]),
            [['google', 'com.exemple.bientot', null]]
        );
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['appstores.add']
        );
    });

    it('gardent l’identité d’une fiche, et en retirent une avec ses chiffres', async () => {
        const repo = fakeRepo({
            sources: [sourceRow({ id: 10 })],
            apps: [appRow({ id: 1 })],
            listings: [covered({ id: 1, app_id: 1, externalId: '1234567890', rating_synced_at: 5 })],
            revenue: [{ app_id: 1, store: 'apple', day: 1, currency: 'EUR', amount: 1, units: 1 }]
        });
        const update = (apple: { sourceId: number | null; externalId: string } | null, ratingCountry = 'FR') =>
            handlerFor(appStoresUpdate)(contextOf(repo), {
                appId: 1,
                name: 'Météo',
                ratingCountry,
                apple,
                google: null
            });
        await assert.rejects(update({ sourceId: 10, externalId: '999' }), failsWith('validation', /garde son app/));
        await update({ sourceId: 10, externalId: '1234567890' }, 'BE');
        assert.equal(repo.db.listings[0].rating_synced_at, null, 'la note se relit dans le nouveau pays');
        await update(null);
        assert.equal(repo.db.listings.length, 0);
        assert.equal(repo.db.revenue.length, 0);
    });

    it('se suppriment chez elles seulement, et oublient leurs projections', async () => {
        const repo = fakeRepo({
            apps: [appRow({ id: 1 }), appRow({ id: 2, workspace_id: 2 })],
            shares: [{ appId: 2, workspaceId: 1 }]
        });
        const ctx = contextOf(repo, { shares: { '2': 2 } });
        await assert.rejects(handlerFor(appStoresRemove)(ctx, { appId: 2 }), failsWith('validation'));
        await handlerFor(appStoresRemove)(ctx, { appId: 1 });
        assert.deepEqual(ctx.forgotten, ['1']);
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['appstores.remove']
        );
    });

    it('listent les sept derniers jours connus, et taisent les apps masquées', async () => {
        const repo = fakeRepo({
            apps: [appRow({ id: 1 }), appRow({ id: 2 })],
            listings: [covered({ id: 1, app_id: 1 })],
            daily: Array.from({ length: 14 }, (_, i) => ({
                app_id: 1,
                store: 'apple' as const,
                day: UNTIL - i,
                downloads: i < 7 ? 3 : 1,
                updates: null,
                uninstalls: null,
                active_devices: null,
                rating_avg: null,
                rating_count: null,
                crash_rate: null,
                anr_rate: null,
                vitals_users: null
            }))
        });
        const { apps } = await handlerFor(appStoresList)(contextOf(repo, { itemRestrictions: { '2': 'none' } }), {});
        assert.deepEqual(
            apps.map((a) => [a.app.id, a.downloads, a.previousDownloads]),
            [[1, 21, 7]]
        );
    });

    it('se disent en cours de synchronisation tant que le rattrapage n’est pas allé au bout', async () => {
        const repo = fakeRepo({
            apps: [appRow({ id: 1 }), appRow({ id: 2 })],
            listings: [
                covered({ id: 1, app_id: 1, metrics_synced_at: null }),
                covered({ id: 2, app_id: 1, store: 'google', metrics_synced_at: 1_700_000_000 }),
                covered({ id: 3, app_id: 2, source_id: null, metrics_synced_at: null })
            ]
        });
        const { apps } = await handlerFor(appStoresList)(contextOf(repo), {});
        assert.deepEqual(
            apps.flatMap((summary) => summary.app.listings.map((l) => [summary.app.id, l.store, l.syncing])),
            [
                [1, 'apple', true],
                [1, 'google', false],
                [2, 'apple', false]
            ],
            'sans source, rien ne tourne'
        );
    });

    it('rendent les versions relevées de chaque store, Google Play compris', async () => {
        const versions = (version: string, state: string) =>
            JSON.stringify({ versions: [{ version, state, since: null }] });
        const repo = fakeRepo({
            apps: [appRow({ id: 1 })],
            listings: [
                covered({ id: 1, app_id: 1, state: versions('4.3.5', 'READY_FOR_DISTRIBUTION') }),
                covered({
                    id: 2,
                    app_id: 1,
                    store: 'google',
                    externalId: 'com.exemple.app',
                    state: versions('4.3.5', 'RELEASE_LIFECYCLE_STATE_PUBLISHED')
                })
            ]
        });
        const { apps } = await handlerFor(appStoresList)(contextOf(repo), {});
        assert.deepEqual(
            apps[0].app.listings.map((l) => [l.store, l.versions.map((v) => v.state)]),
            [
                ['apple', ['READY_FOR_DISTRIBUTION']],
                ['google', ['RELEASE_LIFECYCLE_STATE_PUBLISHED']]
            ]
        );
    });

    it('ne relisent leur année que reliées à une source, et actives', async () => {
        const repo = fakeRepo({
            apps: [appRow({ id: 1 }), appRow({ id: 2 })],
            listings: [listingRow({ id: 1, app_id: 1, source_id: null }), listingRow({ id: 2, app_id: 2 })]
        });
        await assert.rejects(handlerFor(appStoresBackfill)(contextOf(repo), { appId: 1 }), failsWith('validation'));
        await assert.rejects(
            handlerFor(appStoresBackfill)(contextOf(repo, { pausedItems: { apps: ['2'] } }), { appId: 2 }),
            failsWith('quota_exceeded')
        );
        const { app } = await handlerFor(appStoresBackfill)(contextOf(repo), { appId: 2 });
        assert.equal(app.id, 2);
    });
});

describe('la vue d’ensemble', () => {
    const cell = (
        appId: number,
        store: 'apple' | 'google',
        day: number,
        downloads: number,
        over: Partial<DailyCell> = {}
    ): DailyCell => ({
        app_id: appId,
        store,
        day,
        downloads,
        updates: null,
        uninstalls: null,
        active_devices: null,
        rating_avg: null,
        rating_count: null,
        crash_rate: null,
        anr_rate: null,
        vitals_users: null,
        ...over
    });
    const review = (
        id: number,
        appId: number,
        store: 'apple' | 'google',
        rating: number,
        repliedAt: number | null
    ) => ({
        id,
        app_id: appId,
        store,
        external_ref: `r${id}`,
        rating,
        created_at: UNTIL * 86400 + id,
        replied_at: repliedAt,
        content: '{}'
    });

    /** Deux apps à jour, et une troisième dont Google Play a décroché de dix jours. */
    function seeded() {
        return fakeRepo({
            sources: [sourceRow({ id: 10 }), sourceRow({ id: 20, store: 'google' })],
            apps: [appRow({ id: 1 }), appRow({ id: 2 }), appRow({ id: 3 })],
            listings: [
                covered({ id: 1, app_id: 1 }),
                covered({ id: 2, app_id: 1, store: 'google', source_id: 20 }),
                covered({ id: 3, app_id: 2 }),
                covered({ id: 4, app_id: 3, store: 'google', source_id: 20, synced_day: UNTIL - 10 })
            ],
            daily: [
                cell(1, 'apple', UNTIL, 10),
                cell(1, 'google', UNTIL, 30),
                cell(1, 'google', UNTIL - 1, 0, { crash_rate: 0.02, vitals_users: 100 }),
                cell(2, 'apple', UNTIL, 5),
                cell(3, 'google', UNTIL - 12, 99)
            ],
            revenue: [
                { app_id: 1, store: 'apple', day: UNTIL, currency: 'EUR', amount: 10, units: 2 },
                { app_id: 2, store: 'apple', day: UNTIL, currency: 'EUR', amount: 99, units: 1 }
            ],
            reviews: [review(1, 1, 'apple', 4, null), review(2, 2, 'apple', 1, null), review(3, 1, 'google', 2, 1)]
        });
    }

    it('cumule les apps sur une fenêtre commune, sans la fiche qui a décroché de son store', async () => {
        const { overview } = await handlerFor(appStoresOverview)(contextOf(seeded()), { range: '7d' });
        assert.equal(overview.dataUntil, UNTIL * 86400, 'la fiche en retard ne fige pas la fenêtre');
        assert.deepEqual(overview.metrics.downloads, { apple: 15, google: 30 });
        assert.deepEqual(
            overview.apps.map((app) => [app.id, app.downloads, app.points[app.points.length - 1]]),
            [
                [1, 40, 40],
                [2, 5, 5]
            ],
            'le dernier seau de chaque app porte son dernier jour'
        );
        assert.deepEqual(
            overview.left.map((entry) => [entry.id, entry.store, entry.dataUntil]),
            [[3, 'google', (UNTIL - 10) * 86400]]
        );
        assert.equal(overview.metrics.reviews, 3);
        assert.equal(overview.unanswered, 2);
        assert.deepEqual(
            overview.reviews.map((r) => [r.app.id, r.rating]),
            [
                [2, 1],
                [1, 4]
            ],
            'les plus mal notés d’abord'
        );
        assert.deepEqual(
            overview.alerts.map((alert) => alert.id),
            [1],
            'au-dessus du seuil de Google sur ses 28 derniers jours'
        );
        assert.equal(overview.metrics.rating.apple, null, 'une note ne se cumule pas');
    });

    it('ne compte que les revenus des apps où le droit est tenu, et le dit', async () => {
        const repo = seeded();
        const none = await handlerFor(appStoresOverview)(contextOf(repo, { isOwner: false }), { range: '7d' });
        assert.equal(none.overview.revenue, null);
        const { overview } = await handlerFor(appStoresOverview)(
            contextOf(repo, { isOwner: false, extras: { revenue: true }, itemExtras: { '2': { revenue: false } } }),
            { range: '7d' }
        );
        assert.deepEqual(
            overview.revenue?.totals.map((t) => [t.store, t.currency, t.amount]),
            [['apple', 'EUR', 10]]
        );
        assert.equal(overview.revenue?.partial, true);
    });

    it('n’ouvre pas une app masquée au rôle', async () => {
        const { overview } = await handlerFor(appStoresOverview)(
            contextOf(seeded(), { itemRestrictions: { '2': 'none' } }),
            { range: '7d' }
        );
        assert.deepEqual(
            overview.apps.map((app) => app.id),
            [1]
        );
    });
});

describe('les sources', () => {
    const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const input = {
        store: 'apple' as const,
        label: 'Compte principal',
        issuerId: '6A1F0C2E-0000-4000-8000-000000000001',
        keyId: 'ABCDE12345',
        vendorNumber: '87654321',
        privateKey
    };

    function probeAnswers(): void {
        answer((url) => {
            if (url.pathname === '/v1/apps') return json({ data: [{ type: 'apps', id: '1234567890' }] });
            if (url.pathname === '/v1/salesReports') return json({ errors: [] }, 404);
            return json({ data: [] });
        });
    }

    it('testent la clé avant de l’enregistrer, et n’en rendent jamais le secret', async () => {
        probeAnswers();
        const repo = fakeRepo();
        const ctx = contextOf(repo);
        const { source } = await handlerFor(appStoresAddSource)(ctx, input);
        assert.deepEqual(source.capabilities, ['apps', 'downloads', 'ratings', 'reviews', 'revenue', 'versions']);
        assert.equal(source.hasSecret, true);
        assert.equal(source.issuerId, input.issuerId.toLowerCase());
        assert.ok(!JSON.stringify(source).includes('PRIVATE KEY'));
        const { sources } = await handlerFor(appStoresListSources)(ctx, {});
        assert.ok(!JSON.stringify(sources).includes('PRIVATE KEY'));
        assert.equal(repo.db.sources[0].secret_enc, privateKey.trim(), 'le secret est rangé à part');
        assert.ok(!repo.db.sources[0].content.includes('PRIVATE KEY'));
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['appstores.addSource']
        );
    });

    it('refusent un .p8 mal formé sans rien demander à Apple', async () => {
        noNetwork();
        const repo = fakeRepo();
        await assert.rejects(
            handlerFor(appStoresAddSource)(contextOf(repo), { ...input, privateKey: 'pas une clé' }),
            failsWith('validation', /\.p8/)
        );
        assert.equal(repo.db.sources.length, 0);
    });

    it('disent la clé refusée par Apple en clair, et un Apple muet en conflit', async () => {
        answer(() => json({ errors: [{ status: '401' }] }, 401));
        const repo = fakeRepo();
        await assert.rejects(
            handlerFor(appStoresAddSource)(contextOf(repo), input),
            failsWith('validation', /Apple refuse cette clé/)
        );
        answer(() => json({}, 503));
        await assert.rejects(handlerFor(appStoresAddSource)(contextOf(repo), input), failsWith('conflict'));
        assert.equal(repo.db.sources.length, 0);
    });

    it('refusent une clé qu’Apple accepte sans rien lui ouvrir', async () => {
        answer(() => json({ errors: [{ status: '403' }] }, 403));
        const repo = fakeRepo();
        await assert.rejects(
            handlerFor(appStoresAddSource)(contextOf(repo), input),
            failsWith('validation', /aucune donnée/)
        );
        assert.equal(repo.db.sources.length, 0);
    });

    it('gardent leur store et, sans secret neuf, celui en place', async () => {
        probeAnswers();
        const repo = fakeRepo({ sources: [sourceRow({ id: 10, secret_enc: privateKey })] });
        await assert.rejects(
            handlerFor(appStoresUpdateSource)(contextOf(repo), {
                sourceId: 10,
                source: { store: 'google', label: 'Autre', bucket: 'pubsite_prod_rev_0123' }
            }),
            failsWith('validation', /store d’une source/)
        );
        const { source } = await handlerFor(appStoresUpdateSource)(contextOf(repo), {
            sourceId: 10,
            source: { ...input, label: 'Renommée', privateKey: undefined }
        });
        assert.equal(source.label, 'Renommée');
        assert.equal(repo.db.sources[0].secret_enc, privateKey);
    });

    it('ne disent une source perdue qu’au troisième refus', async () => {
        const cipher = contextOf(fakeRepo()).cipher();
        const twice = await toSource(
            cipher,
            sourceRow({ id: 10, failing_count: 2, failing_since: 5, failing_error: 'x' }),
            0
        );
        assert.equal(twice.failingSince, null);
        const thrice = await toSource(
            cipher,
            sourceRow({ id: 10, failing_count: 3, failing_since: 5, failing_error: 'x' }),
            0
        );
        assert.equal(thrice.failingSince, 5);
        assert.equal(thrice.failingError, 'x');
    });
});

import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';

import { dayOfDate } from '../days';
import { unzipFirst } from '../parse/unzip';
import {
    fetchGoogleReleases,
    fetchGoogleReviews,
    probeGoogle,
    fetchVitals,
    forgetGoogleTokens,
    googleToken,
    installsObject,
    listObjects,
    parseInstalls,
    parseRatings,
    parseSales,
    parseServiceAccount,
    type GoogleCredentials
} from './google';
import { GOOGLE_TOKEN_URL } from './oauth';
import { storeHttp, StoreError, type StoreFetch } from './types';

/**
 * Le client de Google sans réseau. Ce qui se vérifie ici ne se verrait nulle
 * part ailleurs : l'adresse des jetons écrite en dur (jamais le `token_uri`
 * du JSON), la signature RS256, les rapports UTF-16 lus par le nom de leurs
 * colonnes, le zip des ventes, et le refus d'un bucket ou d'un paquet mal
 * formé avant qu'il n'entre dans une URL.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const creds: GoogleCredentials = {
    clientEmail: 'deveye@projet.iam.gserviceaccount.com',
    privateKey,
    privateKeyId: 'abc123',
    bucket: 'pubsite_prod_rev_01234567890123456789'
};

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const nov = (d: number) => dayOfDate(2026, 11, d) as number;

const original = storeHttp.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function answer(route: (url: URL, init: RequestInit) => Response): void {
    storeHttp.fetch = (async (url, init) => {
        calls.push({ url, init });
        if (url === GOOGLE_TOKEN_URL) return json({ access_token: 'ya29.jeton', expires_in: 3600 });
        return route(new URL(url), init);
    }) as StoreFetch;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

/** Un zip à une entrée, écrit à la main : de quoi éprouver le lecteur minimal. */
function zipOf(name: string, data: Buffer, method: 0 | 8 = 8, directory = false): Buffer {
    const entries: { name: Buffer; raw: Buffer; size: number; method: number }[] = [];
    if (directory) entries.push({ name: Buffer.from('sales/'), raw: Buffer.alloc(0), size: 0, method: 0 });
    entries.push({
        name: Buffer.from(name),
        raw: method === 8 ? deflateRawSync(data) : data,
        size: data.length,
        method
    });
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(entry.method, 8);
        local.writeUInt32LE(entry.raw.length, 18);
        local.writeUInt32LE(entry.size, 22);
        local.writeUInt16LE(entry.name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(entry.method, 10);
        central.writeUInt32LE(entry.raw.length, 20);
        central.writeUInt32LE(entry.size, 24);
        central.writeUInt16LE(entry.name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, entry.name, entry.raw);
        centrals.push(central, entry.name);
        offset += local.length + entry.name.length + entry.raw.length;
    }
    const directoryBytes = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directoryBytes, end]);
}

beforeEach(() => {
    calls = [];
    forgetGoogleTokens();
});

afterEach(() => {
    storeHttp.fetch = original;
});

describe('le compte de service', () => {
    const validation = (e: unknown) => e instanceof FeatureError && e.code === 'validation';

    it('refuse un texte qui n’est pas du JSON, un autre type de JSON, un JSON incomplet', () => {
        assert.throws(() => parseServiceAccount('pas du json'), validation);
        assert.throws(() => parseServiceAccount(JSON.stringify({ type: 'authorized_user' })), validation);
        assert.throws(
            () => parseServiceAccount(JSON.stringify({ type: 'service_account', client_email: creds.clientEmail })),
            validation
        );
        assert.throws(
            () =>
                parseServiceAccount(
                    JSON.stringify({ type: 'service_account', client_email: creds.clientEmail, private_key: 'nope' })
                ),
            validation
        );
    });

    it('n’en garde que l’adresse, la clé et son identifiant', () => {
        const account = parseServiceAccount(
            JSON.stringify({
                type: 'service_account',
                project_id: 'projet',
                private_key_id: 'abc123',
                private_key: privateKey.replace(/\n/g, '\\n'),
                client_email: creds.clientEmail,
                token_uri: 'https://evil.example/token'
            })
        );
        assert.deepEqual(account, {
            clientEmail: creds.clientEmail,
            privateKey: privateKey.trim(),
            privateKeyId: 'abc123'
        });
    });

    it('échange une assertion RS256 à l’adresse écrite en dur, et garde le jeton', async () => {
        answer(() => json({}));
        assert.equal(await googleToken(creds, undefined, NOW), 'ya29.jeton');
        assert.equal(await googleToken(creds, undefined, NOW + 60_000), 'ya29.jeton');
        assert.equal(calls.length, 1, 'le second appel vient du cache');
        assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
        const body = new URLSearchParams(String(calls[0].init.body));
        assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        const [head, claims, signature] = String(body.get('assertion')).split('.');
        assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), {
            alg: 'RS256',
            typ: 'JWT',
            kid: 'abc123'
        });
        const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, string | number>;
        assert.equal(decoded.iss, creds.clientEmail);
        assert.equal(decoded.aud, 'https://oauth2.googleapis.com/token');
        assert.equal(Number(decoded.exp) - Number(decoded.iat), 3600);
        assert.deepEqual(String(decoded.scope).split(' ').sort(), [
            'https://www.googleapis.com/auth/androidpublisher',
            'https://www.googleapis.com/auth/devstorage.read_only',
            'https://www.googleapis.com/auth/playdeveloperreporting'
        ]);
        assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature, 'base64url')));
    });

    it('dit la clé refusée quand Google rejette l’assertion', async () => {
        storeHttp.fetch = (async () =>
            json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)) as StoreFetch;
        await assert.rejects(googleToken(creds), (e) => e instanceof StoreError && e.status === 401);
    });
});

describe('les rapports du bucket', () => {
    it('lit les installations en UTF-16, par le nom des colonnes', () => {
        const csv = [
            'Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events',
            '2026-11-01,com.exemple.app,10,2,5,1000,"1,234",3,800,12,6,2',
            '2026-11-02,com.exemple.app,8,1,4,1001,7,1,801,9,NA,1'
        ].join('\r\n');
        assert.deepEqual(parseInstalls(utf16(csv)), [
            { day: nov(1), downloads: 1234, updates: 6, uninstalls: 3, activeDevices: 800 },
            { day: nov(2), downloads: 7, updates: null, uninstalls: 1, activeDevices: 801 }
        ]);
    });

    it('lit la note moyenne totale, et passe « NA »', () => {
        const csv = [
            'Date,Package Name,Daily Average Rating,Total Average Rating',
            '2026-11-01,com.exemple.app,NA,4.31',
            '2026-11-02,com.exemple.app,5,NA'
        ].join('\n');
        assert.deepEqual(parseRatings(utf16(csv)), [{ day: nov(1), rating: 4.31 }]);
    });

    it('refuse un rapport qui a changé de forme', () => {
        assert.throws(() => parseInstalls(utf16('Jour,Paquet\n2026-11-01,x')), StoreError);
    });

    it('lit le zip des ventes et les somme par paquet, jour et devise, remboursements en négatif', async () => {
        const csv = [
            'Order Number,Order Charged Date,Order Charged Timestamp,Financial Status,Device Model,Product Title,Product ID,Product Type,SKU ID,Currency of Sale,Item Price,Taxes Collected,Charged Amount',
            'GPA.1,2026-11-01,1,Charged,Pixel,Pro,com.exemple.app,inapp,pro,EUR,4.99,1.00,5.99',
            'GPA.2,2026-11-01,2,Charged,Pixel,Pro,com.exemple.app,inapp,pro,EUR,4.99,1.00,5.99',
            'GPA.3,2026-11-02,3,Refund,Pixel,Pro,com.exemple.app,inapp,pro,EUR,4.99,1.00,5.99',
            'GPA.4,2026-11-02,4,Charged,Pixel,Plus,com.autre.app,subscription,plus,USD,"1,299.00",0,1299.00',
            'GPA.5,2026-11-02,5,Cancelled,Pixel,Pro,com.exemple.app,inapp,pro,EUR,4.99,1.00,5.99'
        ].join('\n');
        const entry = await unzipFirst(zipOf('salesreport_202611.csv', Buffer.from(csv), 8, true), 1 << 20);
        assert.equal(entry.name, 'salesreport_202611.csv');
        const sales = parseSales(entry.data.toString('utf8'));
        const mine = sales.get('com.exemple.app');
        assert.deepEqual(Object.fromEntries(mine?.get(nov(1)) ?? []), { EUR: { amount: 9.98, units: 2 } });
        assert.deepEqual(Object.fromEntries(mine?.get(nov(2)) ?? []), { EUR: { amount: -4.99, units: -1 } });
        assert.deepEqual(Object.fromEntries(sales.get('com.autre.app')?.get(nov(2)) ?? []), {
            USD: { amount: 1299, units: 1 }
        });
    });

    it('lit une entrée stockée sans compression, et borne ce qu’il décompresse', async () => {
        const data = Buffer.from('a,b\n1,2');
        assert.equal((await unzipFirst(zipOf('x.csv', data, 0), 1 << 20)).data.toString(), 'a,b\n1,2');
        await assert.rejects(unzipFirst(zipOf('x.csv', Buffer.alloc(4096, 65)), 100));
    });

    it('refuse un bucket ou un paquet mal formé avant tout appel', async () => {
        storeHttp.fetch = (async () => {
            throw new Error('aucun appel attendu');
        }) as StoreFetch;
        await assert.rejects(listObjects({ ...creds, bucket: 'evil.example/x' }, 'stats/'), /Bucket/);
        assert.throws(() => installsObject('com/../evil', '202611'), /paquet/);
        await assert.rejects(fetchGoogleReviews(creds, 'pas un paquet'), /paquet/);
    });

    it('met le bucket dans le chemin, jamais dans le nom d’hôte', async () => {
        answer(() =>
            json({ items: [{ name: 'stats/installs/installs_com.exemple.app_202611_overview.csv', etag: 'e1' }] })
        );
        const objects = await listObjects(creds, 'stats/installs/installs_com.exemple.app_');
        assert.deepEqual(objects, [
            { name: 'stats/installs/installs_com.exemple.app_202611_overview.csv', etag: 'e1' }
        ]);
        const url = new URL(calls[1].url);
        assert.equal(url.host, 'storage.googleapis.com');
        assert.equal(url.pathname, `/storage/v1/b/${creds.bucket}/o`);
    });
});

describe('les avis et la stabilité', () => {
    it('lit les avis : titre et texte séparés par une tabulation, réponse du développeur comprise', async () => {
        answer(() =>
            json({
                reviews: [
                    {
                        reviewId: 'gp:AOqp1',
                        authorName: 'Jo',
                        comments: [
                            {
                                userComment: {
                                    text: 'Titre\tTexte complet',
                                    lastModified: { seconds: '1763200000' },
                                    starRating: 4,
                                    appVersionName: '1.2.3'
                                }
                            },
                            { developerComment: { text: 'Merci !', lastModified: { seconds: '1763210000' } } }
                        ]
                    }
                ]
            })
        );
        const [review] = await fetchGoogleReviews(creds, 'com.exemple.app');
        assert.deepEqual(review, {
            externalId: 'gp:AOqp1',
            rating: 4,
            title: 'Titre',
            body: 'Texte complet',
            author: 'Jo',
            territory: null,
            appVersion: '1.2.3',
            createdAt: 1763200000,
            reply: { body: 'Merci !', at: 1763210000, state: 'published', responseId: null }
        });
    });

    it('sonde avis, versions et stabilité avec le paquet lu au premier rapport venu, sans la Reporting API', async () => {
        answer((url) => {
            if (url.pathname.endsWith('/apps:search')) return json({ error: { code: 403 } }, 403);
            const prefix = url.searchParams.get('prefix');
            if (prefix === 'stats/installs/installs_') {
                return json({ items: [{ name: 'stats/installs/installs_com.exemple.app_202511_app_version.csv' }] });
            }
            if (prefix !== null) return json({ items: [] });
            if (url.pathname.endsWith('/reviews')) return json({ reviews: [] });
            if (url.pathname.endsWith('/tracks/production/releases')) return json({ releases: [] });
            if (url.pathname.endsWith('/crashRateMetricSet')) return json({});
            return json({}, 404);
        });
        const capabilities = await probeGoogle(creds);
        for (const capability of ['apps', 'downloads', 'reviews', 'versions', 'vitals']) {
            assert.ok(capabilities.includes(capability as never), `${capability} sondée`);
        }
        assert.ok(calls.some((c) => c.url.includes('/applications/com.exemple.app/tracks/production/releases')));
    });

    it('lit les versions de la piste de production, la plus récente d’abord', async () => {
        answer(() =>
            json({
                releases: [
                    {
                        releaseName: '4.3.4',
                        track: 'production',
                        releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
                        activeArtifacts: [{ versionCode: 434 }]
                    },
                    {
                        track: 'production',
                        releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW',
                        activeArtifacts: [{ versionCode: 435 }]
                    }
                ]
            })
        );
        const versions = await fetchGoogleReleases(creds, 'com.exemple.app');
        assert.deepEqual(versions, [
            { version: '435', state: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW', code: 435 },
            { version: '4.3.4', state: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', code: 434 }
        ]);
        assert.equal(
            calls.at(-1)?.url,
            'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.exemple.app/tracks/production/releases'
        );
    });

    it('lit les taux perçus jour par jour, jusqu’à la fraîcheur annoncée', async () => {
        const freshness = {
            freshnessInfo: {
                freshnesses: [
                    {
                        aggregationPeriod: 'DAILY',
                        latestEndTime: { year: 2026, month: 11, day: 15, timeZone: { id: 'America/Los_Angeles' } }
                    }
                ]
            }
        };
        const rowOf = (dayOfMonth: number, metric: string, rate: string, users: string) => ({
            startTime: { year: 2026, month: 11, day: dayOfMonth, timeZone: { id: 'America/Los_Angeles' } },
            metrics: [
                { metric, decimalValue: { value: rate } },
                { metric: 'distinctUsers', decimalValue: { value: users } }
            ]
        });
        answer((url, init) => {
            const crash = url.pathname.includes('crashRateMetricSet');
            if (init.method !== 'POST') return json(freshness);
            return json({
                rows: crash
                    ? [
                          rowOf(13, 'userPerceivedCrashRate', '0.012', '1000'),
                          rowOf(14, 'userPerceivedCrashRate', '0.01', '500')
                      ]
                    : [rowOf(13, 'userPerceivedAnrRate', '0.003', '1000')]
            });
        });
        const days = await fetchVitals(creds, 'com.exemple.app', 30);
        assert.deepEqual(days, [
            { day: nov(13), crashRate: 0.012, anrRate: 0.003, users: 1000 },
            { day: nov(14), crashRate: 0.01, anrRate: null, users: 500 }
        ]);
        const query = calls.find((c) => c.url.endsWith('crashRateMetricSet:query'));
        const body = JSON.parse(String(query?.init.body)) as {
            timelineSpec: { aggregationPeriod: string; endTime: { day: number; timeZone: { id: string } } };
            metrics: string[];
        };
        assert.equal(body.timelineSpec.aggregationPeriod, 'DAILY');
        assert.equal(body.timelineSpec.endTime.day, 15);
        assert.equal(body.timelineSpec.endTime.timeZone.id, 'America/Los_Angeles');
        assert.deepEqual(body.metrics, ['userPerceivedCrashRate', 'distinctUsers']);
    });
});

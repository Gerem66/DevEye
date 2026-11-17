import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';

import { dayOfDate } from '../days';
import {
    appleToken,
    fetchReviewsPage,
    fetchSalesReport,
    figuresFor,
    forgetAppleTokens,
    parseAppleKey,
    parseSalesReport,
    probeApple,
    replyApple,
    skuOf,
    type AppleCredentials
} from './apple';
import { storeHttp, StoreError, type StoreFetch } from './types';

/**
 * Le client d'Apple sans réseau : le transport est remplacé, chaque réponse
 * est écrite ici. On tient ce qu'aucune autre couche ne vérifierait : la
 * signature du jeton, la lecture du rapport de ventes (premiers
 * téléchargements seuls, achats intégrés rattachés par SKU parent), et la
 * différence entre un jour sans vente et un jour pas encore publié.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const creds: AppleCredentials = {
    issuerId: '6a1f0c2e-0000-4000-8000-000000000001',
    keyId: 'ABCDE12345',
    vendorNumber: '87654321',
    privateKey
};

/** Le 16 novembre 2026 à midi, heure du Pacifique. */
const NOW = Date.UTC(2026, 10, 16, 20, 0, 0);
const day = (d: number) => dayOfDate(2026, 11, d) as number;

const original = storeHttp.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function answer(route: (url: URL, init: RequestInit) => Response | Promise<Response>): void {
    storeHttp.fetch = (async (url, init) => {
        calls.push({ url, init });
        return route(new URL(url), init);
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

const HEADER = [
    'Provider',
    'Provider Country',
    'SKU',
    'Developer',
    'Title',
    'Version',
    'Product Type Identifier',
    'Units',
    'Developer Proceeds',
    'Begin Date',
    'End Date',
    'Customer Currency',
    'Country Code',
    'Currency of Proceeds',
    'Apple Identifier',
    'Customer Price',
    'Promo Code',
    'Parent Identifier'
];

function line(cells: Record<string, string>): string {
    return HEADER.map((name) => cells[name] ?? '').join('\t');
}

const row = (
    sku: string,
    type: string,
    units: string,
    proceeds: string,
    currency: string,
    id: string,
    parent = '',
    country = 'FR'
) =>
    line({
        Provider: 'APPLE',
        SKU: sku,
        'Product Type Identifier': type,
        Units: units,
        'Developer Proceeds': proceeds,
        'Begin Date': '11/14/2026',
        'End Date': '11/14/2026',
        'Currency of Proceeds': currency,
        'Country Code': country,
        'Apple Identifier': id,
        'Parent Identifier': parent
    });

const REPORT = [
    HEADER.join('\t'),
    row('meteo-sku', '1', '12', '0', 'EUR', '1234567890'),
    row('meteo-sku', '1F', '3', '0', 'EUR', '1234567890', '', 'BE'),
    row('meteo-sku', '1', '1', '0', 'EUR', '1234567890', '', 'DE'),
    row('meteo-sku', '1', '-1', '0', 'EUR', '1234567890', '', 'DE'),
    row('meteo-sku', '7', '40', '0', 'EUR', '1234567890'),
    row('meteo-sku', '3', '5', '0', 'EUR', '1234567890'),
    row('meteo.pro', 'IA1', '2', '1.40', 'EUR', '9990001', 'meteo-sku'),
    row('meteo.pro', 'IA1', '-1', '1.40', 'EUR', '9990001', 'meteo-sku'),
    row('meteo.sub', 'IAY', '1', '3.50', 'USD', '9990002', 'meteo-sku'),
    row('notes-sku', '1', '7', '0.70', 'EUR', '5550000')
].join('\n');

describe('le jeton App Store Connect', () => {
    it('se signe en ES256 brut, que la clé publique vérifie', () => {
        const token = appleToken(creds, NOW);
        const [head, body, signature] = token.split('.');
        assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), {
            alg: 'ES256',
            kid: 'ABCDE12345',
            typ: 'JWT'
        });
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, number | string>;
        assert.equal(claims.iss, creds.issuerId);
        assert.equal(claims.aud, 'appstoreconnect-v1');
        assert.equal(Number(claims.exp) - Number(claims.iat), 19 * 60);
        const raw = Buffer.from(signature, 'base64url');
        assert.equal(raw.length, 64, 'r‖s, pas une signature DER');
        assert.ok(verify('sha256', Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
    });

    it('reste en cache jusqu’à une minute de sa fin', () => {
        const first = appleToken(creds, NOW);
        assert.equal(appleToken(creds, NOW + 17 * 60_000), first);
        assert.notEqual(appleToken(creds, NOW + 18.5 * 60_000), first);
    });

    it('refuse un .p8 qui n’en est pas un, ou une clé RSA', () => {
        const rsa = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' }
        }).privateKey;
        const validation = (e: unknown) => e instanceof FeatureError && e.code === 'validation';
        assert.throws(() => parseAppleKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'), validation);
        assert.throws(() => parseAppleKey(rsa), validation);
        assert.equal(parseAppleKey(`  ${privateKey}  `), privateKey.trim());
    });
});

describe('le rapport de ventes quotidien', () => {
    it('compte les premiers téléchargements et les produits, achats intégrés rattachés par leur SKU parent', () => {
        const rows = parseSalesReport(REPORT);
        const meteo = figuresFor(rows, { appleId: '1234567890', sku: 'meteo-sku' });
        assert.equal(meteo.downloads, 15, 'ni mises à jour, ni retéléchargements, ni achats intégrés');
        assert.deepEqual(Object.fromEntries(meteo.countries), { FR: 12, BE: 3 }, 'un pays remboursé n’en est plus un');
        assert.equal(meteo.updates, 40);
        assert.deepEqual(Object.fromEntries(meteo.revenue), {
            EUR: { amount: 1.4, units: 1 },
            USD: { amount: 3.5, units: 1 }
        });
        const notes = figuresFor(rows, { appleId: '5550000', sku: 'notes-sku' });
        assert.equal(notes.downloads, 7);
        assert.deepEqual(Object.fromEntries(notes.revenue), { EUR: { amount: 4.9, units: 7 } });
    });

    it('sans le SKU de l’app, ses achats intégrés restent dehors, et ses lignes le donnent', () => {
        const rows = parseSalesReport(REPORT);
        assert.deepEqual([...figuresFor(rows, { appleId: '1234567890', sku: null }).revenue.keys()], []);
        assert.equal(skuOf(rows, '1234567890'), 'meteo-sku');
    });

    it('lit les colonnes par leur nom, dans n’importe quel ordre', () => {
        const swapped = REPORT.split('\n')
            .map((l) => l.split('\t').reverse().join('\t'))
            .join('\n');
        const meteo = figuresFor(parseSalesReport(swapped), { appleId: '1234567890', sku: 'meteo-sku' });
        assert.equal(meteo.downloads, 15);
    });

    it('refuse un rapport qui a changé de forme', () => {
        assert.throws(() => parseSalesReport('Foo\tBar\n1\t2'), StoreError);
    });

    it('se demande en version 1_0, pour le compte du numéro de fournisseur, et se décompresse', async () => {
        answer(() => new Response(gzipSync(Buffer.from(REPORT)), { status: 200 }));
        const report = await fetchSalesReport(creds, day(13), undefined, NOW);
        assert.equal(report.kind, 'rows');
        const [call] = calls;
        const url = new URL(call.url);
        assert.equal(url.host, 'api.appstoreconnect.apple.com');
        assert.equal(url.searchParams.get('filter[version]'), '1_0');
        assert.equal(url.searchParams.get('filter[vendorNumber]'), '87654321');
        assert.equal(url.searchParams.get('filter[reportDate]'), '2026-11-13');
        assert.equal(url.searchParams.get('filter[frequency]'), 'DAILY');
        const headers = call.init.headers as Record<string, string>;
        assert.equal(headers.Accept, 'application/a-gzip');
        assert.match(headers.Authorization, /^Bearer /);
        assert.equal(headers['User-Agent'], 'DevEye');
    });

    it('distingue un jour sans vente d’un jour pas encore publié, à l’heure du Pacifique', async () => {
        answer(() => json({ errors: [{ status: '404', detail: 'There were no sales for the date specified.' }] }, 404));
        assert.equal((await fetchSalesReport(creds, day(13), undefined, NOW)).kind, 'empty');
        assert.equal((await fetchSalesReport(creds, day(14), undefined, NOW)).kind, 'empty');
        assert.equal((await fetchSalesReport(creds, day(15), undefined, NOW)).kind, 'pending');
        answer(() => json({ errors: [] }, 410));
        assert.equal((await fetchSalesReport(creds, day(1), undefined, NOW)).kind, 'expired');
    });

    it('lève une erreur de store pour un refus de la clé', async () => {
        answer(() => json({ errors: [{ status: '401' }] }, 401));
        await assert.rejects(
            fetchSalesReport(creds, day(13), undefined, NOW),
            (e) => e instanceof StoreError && e.status === 401
        );
    });
});

describe('les avis et les réponses', () => {
    it('lit une page, réponses en attente comprises', async () => {
        answer(() =>
            json({
                data: [
                    {
                        type: 'customerReviews',
                        id: 'aaaa-1111',
                        attributes: {
                            rating: 2,
                            title: 'Bof',
                            body: 'Plante au démarrage',
                            reviewerNickname: 'Léa',
                            createdDate: '2026-11-15T10:00:00-08:00',
                            territory: 'FRA'
                        },
                        relationships: { response: { data: { type: 'customerReviewResponses', id: 'resp-1' } } }
                    },
                    {
                        type: 'customerReviews',
                        id: 'bbbb-2222',
                        attributes: { rating: 5, body: 'Parfait', createdDate: '2026-11-14T10:00:00Z' }
                    }
                ],
                included: [
                    {
                        type: 'customerReviewResponses',
                        id: 'resp-1',
                        attributes: {
                            responseBody: 'Merci',
                            lastModifiedDate: '2026-11-15T12:00:00Z',
                            state: 'PENDING_PUBLISH'
                        }
                    }
                ],
                links: { next: 'https://api.appstoreconnect.apple.com/v1/apps/1234567890/customerReviews?cursor=x' }
            })
        );
        const page = await fetchReviewsPage(creds, '/v1/apps/1234567890/customerReviews?limit=200');
        assert.equal(page.reviews.length, 2);
        assert.deepEqual(page.reviews[0].reply, {
            body: 'Merci',
            at: Date.parse('2026-11-15T12:00:00Z') / 1000,
            state: 'pending',
            responseId: 'resp-1'
        });
        assert.equal(page.reviews[0].territory, 'FRA');
        assert.equal(page.reviews[1].reply, null);
        assert.ok(page.next?.startsWith('https://api.appstoreconnect.apple.com/v1/'));
    });

    it('ne suit pas un lien de page qui sortirait de chez Apple', async () => {
        answer(() => json({ data: [], links: { next: 'https://evil.example/v1/x' } }));
        await assert.rejects(fetchReviewsPage(creds, '/v1/apps/1/customerReviews'), StoreError);
    });

    it('remplace une réponse en supprimant l’ancienne, puis en créant la nouvelle', async () => {
        answer((_url, init) =>
            init.method === 'DELETE'
                ? new Response(null, { status: 204 })
                : json(
                      {
                          data: {
                              type: 'customerReviewResponses',
                              id: 'resp-2',
                              attributes: { responseBody: 'Corrigé', state: 'PENDING_PUBLISH' }
                          }
                      },
                      201
                  )
        );
        const reply = await replyApple(creds, 'aaaa-1111', 'Corrigé', 'resp-1');
        assert.deepEqual(
            calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`),
            ['DELETE /v1/customerReviewResponses/resp-1', 'POST /v1/customerReviewResponses']
        );
        const body = JSON.parse(String(calls[1].init.body)) as {
            data: { relationships: { review: { data: { id: string } } } };
        };
        assert.equal(body.data.relationships.review.data.id, 'aaaa-1111');
        assert.deepEqual(reply, { body: 'Corrigé', at: null, state: 'pending', responseId: 'resp-2' });
    });
});

describe('le test d’une clé', () => {
    it('lève quand Apple refuse la clé elle-même', async () => {
        answer(() => json({ errors: [{ status: '401' }] }, 401));
        await assert.rejects(probeApple(creds, undefined, NOW), (e) => e instanceof StoreError && e.status === 401);
    });

    it('range ce qui a répondu, et laisse de côté ce que le rôle ferme', async () => {
        answer((url) => {
            if (url.pathname === '/v1/apps') return json({ data: [{ type: 'apps', id: '1234567890' }] });
            if (url.pathname === '/v1/salesReports') return json({ errors: [] }, 403);
            if (url.pathname.endsWith('/customerReviews')) return json({ data: [] });
            return json({ errors: [] }, 403);
        });
        const capabilities = await probeApple(creds, undefined, NOW);
        assert.deepEqual(capabilities.sort(), ['apps', 'ratings', 'reviews']);
    });

    it('ne cache pas une panne d’Apple derrière une capacité manquante', async () => {
        answer(() => json({ errors: [] }, 503));
        await assert.rejects(probeApple(creds, undefined, NOW), (e) => e instanceof StoreError && e.status === 503);
    });
});

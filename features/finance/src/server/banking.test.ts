import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { SdkPublicApp, SdkPublicHandler, SdkPublicReply } from '@deveye/types/sdk/server';
import { createTestContext, createTestServiceDeps } from '@deveye/types/sdk/testing';

import {
    financeAccountAdd,
    financeAccountBankLink,
    financeBankList,
    financeConnectionAddQonto,
    financeConnectionStart,
    financeConnectionSync,
    financeStatementImport,
    financeTransactionAdd
} from '../contracts/commands';
import type { FinanceConnectionRow } from '../contracts/banking';
import { enableBankingProblem, type EnableBankingAccount } from './banks/enableBanking';
import { bankHttp, centsOf } from './banks/types';
import { sealConnection, type StoredConnection } from './banking';
import { env } from './env';
import { financeRoutes, type FinanceRouteSeam } from './routes';
import { createService } from './service';
import { addDays, today, type Ctx } from './_shared';
import { fakeRepo, handlerFor, type FakeRepo } from './_testing';

/**
 * Les connexions bancaires, contre de faux serveurs Qonto et Enable Banking.
 * Ce qu'elles promettent : rien ne s'enregistre que la banque refuse, une ligne
 * relevée n'entre qu'une fois et passe par le même rapprochement qu'un import,
 * l'offre borne ce qui interroge une banque à vie, et un consentement qui finit
 * se dit une fois, avant qu'il ne finisse.
 */

const DAY = today();

type Reply = { status?: number; body?: unknown };
type Route = (url: URL, init: RequestInit) => Reply;

const realFetch = bankHttp.fetch;
let calls: { method: string; url: URL; init: RequestInit }[] = [];

/** Un faux serveur : `GET /v2/organization` → sa réponse. */
function serve(routes: Record<string, Route>) {
    calls = [];
    bankHttp.fetch = async (raw, init = {}) => {
        const url = new URL(raw);
        const method = init.method ?? 'GET';
        calls.push({ method, url, init });
        const route = routes[`${method} ${url.pathname}`];
        if (!route) return new Response('{}', { status: 404 });
        const reply = route(url, init);
        return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
            status: reply.status ?? 200
        });
    };
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

async function book(overrides: { quotaLimits?: Record<string, number> } = {}) {
    const repo = fakeRepo();
    const ctx = createTestContext({ repo, ...overrides });
    const { account } = await handlerFor(financeAccountAdd)(ctx, {
        account: {
            name: 'Compte pro',
            kind: 'checking',
            color: 'blue',
            initialBalance: 0,
            openedOn: addDays(DAY, -60),
            note: '',
            archived: false
        }
    });
    return { repo, ctx, account };
}

function qontoServer(transactions: unknown[][] = [[]]) {
    serve({
        'GET /v2/organization': (_url, init) =>
            header(init, 'Authorization') === 'org-1:secret'
                ? {
                      body: {
                          organization: {
                              bank_accounts: [
                                  {
                                      id: 'acc-1',
                                      name: 'Principal',
                                      iban: 'FR7630001007941234567890185',
                                      currency: 'EUR',
                                      status: 'active',
                                      balance_cents: 123_456
                                  }
                              ]
                          }
                      }
                  }
                : { status: 401, body: { message: 'unauthorized' } },
        'GET /v2/transactions': (url) => {
            const page = Number(url.searchParams.get('current_page'));
            return {
                body: {
                    transactions: transactions[page - 1] ?? [],
                    meta: { next_page: page < transactions.length ? page + 1 : null }
                }
            };
        }
    });
}

const qontoLine = (id: string, day: string, cents: number, side: 'debit' | 'credit', label: string) => ({
    id,
    amount_cents: cents,
    side,
    label,
    reference: '',
    status: 'completed',
    settled_at: `${day}T10:00:00.000Z`
});

afterEach(() => {
    bankHttp.fetch = realFetch;
    env.ENABLE_BANKING_APP_ID = '';
    env.ENABLE_BANKING_PRIVATE_KEY = '';
});

describe('les montants d’une API', () => {
    it('passe en centimes sans arrondi de travers', () => {
        assert.equal(centsOf('1234.5'), 123_450);
        assert.equal(centsOf('-0.07'), -7);
        assert.equal(centsOf(12.3), 1_230);
        assert.equal(centsOf('abc'), null);
    });
});

describe('Qonto', () => {
    it('refuse une clé que Qonto refuse, sans rien enregistrer', async () => {
        qontoServer();
        const b = await book();
        await assert.rejects(
            handlerFor(financeConnectionAddQonto)(b.ctx, { label: 'Qonto', login: 'org-1', secretKey: 'faux' }),
            /refuse/
        );
        assert.equal(b.repo.connections.length, 0);

        const { connection } = await handlerFor(financeConnectionAddQonto)(b.ctx, {
            label: 'Qonto',
            login: 'org-1',
            secretKey: 'secret'
        });
        assert.deepEqual(connection.accounts, [{ id: 'acc-1', name: 'Principal', ibanEnd: '0185', currency: 'EUR' }]);
        assert.equal(connection.bankName, 'Qonto');
    });

    it('relève depuis le lendemain du dernier import, sans doublon, et garde le solde une fois', async () => {
        const b = await book();
        await handlerFor(financeStatementImport)(b.ctx, {
            accountId: b.account.id,
            format: 'csv',
            lines: [
                { date: addDays(DAY, -10), direction: 'out', amount: 900, label: 'CB CAFE', memo: '', fitid: null }
            ],
            closing: null,
            mapping: null
        });
        qontoServer([
            [
                qontoLine('t-1', addDays(DAY, -9), 1_200, 'debit', 'OVH'),
                qontoLine('t-2', addDays(DAY, -5), 60_000, 'credit', 'ACME')
            ],
            [qontoLine('t-3', addDays(DAY, -1), 3_000, 'debit', 'FREE')]
        ]);
        const { connection } = await handlerFor(financeConnectionAddQonto)(b.ctx, {
            label: 'Qonto',
            login: 'org-1',
            secretKey: 'secret'
        });
        const { added, links } = await handlerFor(financeAccountBankLink)(b.ctx, {
            accountId: b.account.id,
            connectionId: connection.id,
            externalAccountId: 'acc-1'
        });
        assert.equal(added, 3);
        assert.equal(links[0].since, addDays(DAY, -9));
        const asked = calls.find((call) => call.url.pathname === '/v2/transactions');
        assert.equal(asked?.url.searchParams.get('settled_at_from'), `${addDays(DAY, -9)}T00:00:00.000Z`);
        assert.equal(asked?.url.searchParams.get('bank_account_id'), 'acc-1');
        assert.ok(b.repo.lines.filter((l) => l.external_id.startsWith('qonto:')).length === 3);
        const credit = b.repo.lines.find((l) => l.external_id === 'qonto:t-2');
        assert.equal(credit?.direction, 'in');

        const again = await handlerFor(financeConnectionSync)(b.ctx, { connectionId: connection.id });
        assert.equal(again.added, 0);
        assert.equal(again.connection.status, 'ok');
        const closings = b.repo.imports.filter((i) => i.closing_balance !== null);
        assert.equal(closings.length, 1);
        assert.equal(closings[0].closing_balance, 123_456);
    });

    it('rapproche une ligne relevée de l’opération déjà au livre', async () => {
        const b = await book();
        const { transaction } = await handlerFor(financeTransactionAdd)(b.ctx, {
            transaction: {
                accountId: b.account.id,
                kind: 'expense',
                amount: 4_990,
                date: addDays(DAY, -2),
                label: 'LDLC',
                categoryId: null,
                transferAccountId: null,
                counterparty: '',
                note: '',
                vatAmount: null,
                cleared: false
            }
        });
        qontoServer([[qontoLine('t-9', addDays(DAY, -1), 4_990, 'debit', 'LDLC')]]);
        const { connection } = await handlerFor(financeConnectionAddQonto)(b.ctx, {
            label: 'Qonto',
            login: 'org-1',
            secretKey: 'secret'
        });
        await handlerFor(financeAccountBankLink)(b.ctx, {
            accountId: b.account.id,
            connectionId: connection.id,
            externalAccountId: 'acc-1'
        });
        assert.equal(b.repo.lines[0].transaction_id, transaction.id);
        assert.equal(b.repo.transactions[0].cleared, 1);
    });

    it('borne les connexions par l’offre, et ne relève pas à la main une connexion en pause', async () => {
        qontoServer();
        const b = await book({ quotaLimits: { bankConnections: 1 } });
        const first = await handlerFor(financeConnectionAddQonto)(b.ctx, {
            label: 'A',
            login: 'org-1',
            secretKey: 'secret'
        });
        await assert.rejects(
            handlerFor(financeConnectionAddQonto)(b.ctx, { label: 'B', login: 'org-1', secretKey: 'secret' }),
            (e: { code?: string }) => e.code === 'quota_exceeded'
        );
        const paused = createTestContext({
            repo: b.repo,
            pausedItems: { bankConnections: [String(first.connection.id)] }
        });
        await assert.rejects(
            handlerFor(financeConnectionSync)(paused, { connectionId: first.connection.id }),
            (e: { code?: string }) => e.code === 'quota_exceeded'
        );
    });

    it('refuse de relier un même compte de la banque à deux comptes du livre', async () => {
        qontoServer();
        const b = await book();
        const { account: other } = await handlerFor(financeAccountAdd)(b.ctx, {
            account: {
                name: 'Autre',
                kind: 'checking',
                color: 'green',
                initialBalance: 0,
                openedOn: DAY,
                note: '',
                archived: false
            }
        });
        const { connection } = await handlerFor(financeConnectionAddQonto)(b.ctx, {
            label: 'Qonto',
            login: 'org-1',
            secretKey: 'secret'
        });
        const link = (accountId: number) =>
            handlerFor(financeAccountBankLink)(b.ctx, {
                accountId,
                connectionId: connection.id,
                externalAccountId: 'acc-1'
            });
        await link(b.account.id);
        await assert.rejects(link(other.id), /déjà un autre compte/);
    });
});

describe('Enable Banking', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    beforeEach(() => {
        env.ENABLE_BANKING_APP_ID = 'app-1';
        env.ENABLE_BANKING_PRIVATE_KEY = pem.replace(/\n/g, '\\n');
    });

    const aspsps = () => ({
        body: {
            aspsps: [
                {
                    name: 'Banque Populaire',
                    country: 'FR',
                    psu_types: ['business', 'personal'],
                    maximum_consent_validity: 7_776_000
                }
            ]
        }
    });

    it('dit ce qui cloche dans la configuration, et rien quand rien n’est demandé', () => {
        assert.equal(enableBankingProblem(), null);
        env.ENABLE_BANKING_PRIVATE_KEY = '';
        assert.match(enableBankingProblem() ?? '', /sans ENABLE_BANKING_PRIVATE_KEY/);
        env.ENABLE_BANKING_APP_ID = '';
        assert.equal(enableBankingProblem(), null);
        env.ENABLE_BANKING_APP_ID = 'app-1';
        env.ENABLE_BANKING_PRIVATE_KEY = 'pas une clé';
        assert.match(enableBankingProblem() ?? '', /ne se lit pas/);
    });

    it('signe chaque appel d’un jeton RS256 à la clé de l’application', async () => {
        serve({ 'GET /aspsps': aspsps });
        const b = await book();
        const { banks } = await handlerFor(financeBankList)(b.ctx, { country: 'FR' });
        assert.deepEqual(banks, [{ name: 'Banque Populaire', country: 'FR', psuTypes: ['business', 'personal'] }]);

        const jwt = (header(calls[0].init, 'Authorization') ?? '').replace(/^Bearer /, '');
        const [head, body, signature] = jwt.split('.');
        assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), {
            typ: 'JWT',
            alg: 'RS256',
            kid: 'app-1'
        });
        assert.equal(JSON.parse(Buffer.from(body, 'base64url').toString()).aud, 'api.enablebanking.com');
        const verified = createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, signature, 'base64url');
        assert.ok(verified);
    });

    it('envoie consentir chez la banque, puis crée la connexion au retour', async () => {
        const sent: { state: string; redirect_url: string; psu_type: string; access: { valid_until: string } }[] = [];
        serve({
            'GET /aspsps': aspsps,
            'POST /auth': (_url, init) => {
                sent.push(JSON.parse(String(init.body)));
                return { body: { url: 'https://banque.example/consent' } };
            }
        });
        const b = await book();
        const { authUrl } = await handlerFor(financeConnectionStart)(b.ctx, {
            connectionId: null,
            label: 'BP pro',
            bank: { name: 'Banque Populaire', country: 'fr' },
            psuType: 'business'
        });
        assert.equal(authUrl, 'https://banque.example/consent');
        assert.equal(sent.length, 1);
        const [request] = sent;
        assert.equal(request.redirect_url, 'https://deveye.test/api/finance/bank/callback');
        assert.equal(request.psu_type, 'business');
        const days = (Date.parse(request.access.valid_until) - Date.now()) / 86_400_000;
        assert.ok(days > 89 && days <= 90);

        const deps = createTestServiceDeps({ repo: b.repo });
        const { page, text } = await callback(deps, { code: 'c-1', state: request.state }, async () => ({
            sessionId: 's-1',
            validUntil: Math.floor(Date.now() / 1000) + 90 * 86_400,
            accounts: [{ id: 'uid-1', name: 'Courant', ibanEnd: '1234', currency: 'EUR', key: 'hash-1' }]
        }));
        assert.match(text(), /Banque reliée/);
        assert.equal(page.ok, 'true');
        assert.equal(b.repo.connections.length, 1);
        assert.equal(b.repo.connections[0].provider, 'enablebanking');
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('reconnecte sans rien délier : chaque compte retrouve le sien', async () => {
        serve({ 'DELETE /sessions/s-old': () => ({ status: 204 }) });
        const b = await book();
        const id = await addEnableBanking(b.repo, b.ctx, 'hash-1');
        await b.repo.setBankLink(b.account.id, 1, { connectionId: id, externalAccountId: 'uid-old', since: DAY });
        const state = await b.ctx.secrecy.ticket({
            connectionId: id,
            label: 'BP pro',
            bank: 'Banque Populaire',
            country: 'FR',
            psuType: 'business'
        });
        const deps = createTestServiceDeps({ repo: b.repo });
        await callback(deps, { code: 'c-2', state }, async () => ({
            sessionId: 's-new',
            validUntil: Math.floor(Date.now() / 1000) + 90 * 86_400,
            accounts: [{ id: 'uid-new', name: 'Courant', ibanEnd: '1234', currency: 'EUR', key: 'hash-1' }]
        }));
        assert.equal(b.repo.links[0].external_account_id, 'uid-new');
        assert.equal(b.repo.links[0].since, DAY);
        assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.pathname === '/sessions/s-old'));
        assert.equal(b.repo.connections.length, 1);
    });

    it('relève les lignes comptabilisées, page après page, et le solde de clôture', async () => {
        serve({
            'GET /accounts/uid-old/transactions': (url) =>
                url.searchParams.get('continuation_key') === null
                    ? {
                          body: {
                              transactions: [
                                  {
                                      entry_reference: 'e-1',
                                      transaction_amount: { amount: '600.00', currency: 'EUR' },
                                      credit_debit_indicator: 'CRDT',
                                      status: 'BOOK',
                                      booking_date: DAY,
                                      debtor: { name: 'ACME' },
                                      remittance_information: ['Facture', 'F-7']
                                  },
                                  {
                                      entry_reference: 'e-2',
                                      transaction_amount: { amount: '5.00', currency: 'EUR' },
                                      credit_debit_indicator: 'DBIT',
                                      status: 'PDNG',
                                      booking_date: DAY
                                  }
                              ],
                              continuation_key: 'next'
                          }
                      }
                    : {
                          body: {
                              transactions: [
                                  {
                                      transaction_amount: { amount: '12.30', currency: 'EUR' },
                                      credit_debit_indicator: 'DBIT',
                                      booking_date: DAY,
                                      creditor: { name: 'OVH' }
                                  }
                              ]
                          }
                      },
            'GET /accounts/uid-old/balances': () => ({
                body: {
                    balances: [
                        { balance_amount: { amount: '99.00' }, balance_type: 'ITAV' },
                        { balance_amount: { amount: '1500.50' }, balance_type: 'CLBD', reference_date: DAY }
                    ]
                }
            })
        });
        const b = await book();
        const id = await addEnableBanking(b.repo, b.ctx, 'hash-1');
        const { added } = await handlerFor(financeAccountBankLink)(b.ctx, {
            accountId: b.account.id,
            connectionId: id,
            externalAccountId: 'uid-old'
        });
        assert.equal(added, 2);
        const incoming = b.repo.lines.find((l) => l.external_id === 'enablebanking:e-1');
        assert.equal(incoming?.amount, 60_000);
        assert.equal(incoming?.direction, 'in');
        assert.ok(b.repo.lines.some((l) => l.external_id.startsWith('csv:') && l.amount === 1_230));
        assert.equal(b.repo.imports.at(-1)?.closing_balance, 150_050);
    });

    it('prévient une fois une semaine avant la fin du consentement, puis à la fin', async () => {
        const b = await book();
        const id = await addEnableBanking(b.repo, b.ctx, 'hash-1');
        const row = b.repo.connections.find((c) => c.id === id) as FinanceConnectionRow;
        row.valid_until = Math.floor(Date.now() / 1000) + 3 * 86_400;
        const deps = createTestServiceDeps({ repo: b.repo });
        createService(deps);
        const relieve = deps.recorded.tickers[1];
        serve({});
        await relieve.tick();
        await relieve.tick();
        assert.equal(deps.recorded.notifications.length, 1);
        assert.match(JSON.stringify(deps.recorded.notifications[0]), /à renouveler/);

        row.valid_until = Math.floor(Date.now() / 1000) - 60;
        await relieve.tick();
        await relieve.tick();
        assert.equal(deps.recorded.notifications.length, 2);
        assert.equal(row.status, 'expired');
    });
});

/** Une connexion Enable Banking déjà là, dont le compte `uid-old` porte `key`. */
async function addEnableBanking(repo: FakeRepo, ctx: Pick<Ctx, 'cipher'>, key: string): Promise<number> {
    const account: EnableBankingAccount = { id: 'uid-old', name: 'Courant', ibanEnd: '1234', currency: 'EUR', key };
    const stored: StoredConnection = {
        label: 'BP pro',
        bankName: 'Banque Populaire',
        country: 'FR',
        psuType: 'business',
        secret: { sessionId: 's-old' },
        accounts: [account]
    };
    return repo.createConnection(1, {
        provider: 'enablebanking',
        validUntil: Math.floor(Date.now() / 1000) + 30 * 86_400,
        content: await sealConnection(ctx, stored)
    });
}

/** Le retour de la banque, sur une surface qui retient la route. */
async function callback(
    deps: ReturnType<typeof createTestServiceDeps<FakeRepo>>,
    query: Record<string, string>,
    openSession: NonNullable<FinanceRouteSeam['openSession']>
) {
    const handlers = new Map<string, SdkPublicHandler>();
    const app: SdkPublicApp = {
        get: (path, _opts, handler) => handlers.set(path, handler),
        post: () => assert.fail('aucune route POST attendue'),
        postStream: () => assert.fail('aucune route en flux attendue')
    };
    financeRoutes(app, deps, { openSession });
    let payload = '';
    const reply: SdkPublicReply = {
        header: () => reply,
        code: () => reply,
        send(body) {
            payload = String(body);
            return reply;
        }
    };
    const handler = handlers.get('/api/finance/bank/callback');
    assert.ok(handler);
    await handler({ query } as never, reply);
    const ok = /data-ok="(true|false)"/.exec(payload)?.[1];
    return { page: { ok }, text: () => payload };
}

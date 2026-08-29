import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MailAccountRow, MailFolderRow, MailMessageRow } from '../contracts/domain';
import type {
    SdkCipher,
    SdkPublicApp,
    SdkPublicHandler,
    SdkPublicReply,
    SdkPublicRouteOptions
} from '@deveye/types/sdk/server';
import { createTestServiceDeps, type TestServiceDeps } from '@deveye/types/sdk/testing';

import type { MailRepo } from './repo';
import { mailRoutes } from './routes';

/**
 * Les routes publiques du module, sur une surface `SdkPublicApp` factice qui
 * retient ce qu'on lui déclare, et le rendu des tickets du harnais.
 *
 * Ce qui se tient ici est ce que l'hôte ne vérifie pas pour nous : les deux
 * routes ne montent que sur l'origine de l'app ; une pièce jointe ne sort que
 * contre un ticket valide, sous le codec du domicile du compte ; le retour OAuth
 * crée le compte sous le bon codec et poste vers l'origine de l'app, un `state`
 * invalide rendant la page d'échec sans rien écrire.
 */

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
            post: (path, opts, handler) => routes.push({ method: 'post', path, opts, handler })
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

interface FakeRepo extends MailRepo {
    accountRows: MailAccountRow[];
}

async function unused(): Promise<never> {
    throw new Error('non attendu ici');
}

/** Un compte en base, tel que le vrai dépôt le rendrait (contenu étiqueté par le codec de son palier). */
function account(over: Partial<MailAccountRow> & { id: number }): MailAccountRow {
    const tag = over.security_tier === 'guarded' ? 'private' : 'server';
    return {
        user_id: 1,
        workspace_id: 1,
        sort_order: 0,
        display_name_enc: `${tag}:Perso`,
        email_address_enc: `${tag}:moi@exemple.fr`,
        security_tier: 'open',
        auth_method: 'password',
        enabled: 1,
        sync_interval_seconds: 600,
        last_sync_at: null,
        last_sync_error_enc: null,
        last_sync_status: 'ok',
        last_error_at: null,
        credentials_enc: `${tag}:${JSON.stringify({
            kind: 'password',
            imap: { host: 'imap.exemple.fr', port: 993, username: 'moi', password: 'x' },
            smtp: { host: 'smtp.exemple.fr', port: 465, username: 'moi', password: 'x' },
            proxy: null
        })}`,
        created: 1,
        ...over
    };
}

const FOLDER: MailFolderRow = {
    id: 10,
    account_id: 1,
    imap_path: 'INBOX',
    name_enc: 'server:Boîte de réception',
    special_use: 'inbox',
    sort_order: 0,
    uid_validity: 1,
    last_seen_uid: 5,
    first_seen_uid: 1,
    unread_count: 0,
    total_count: 1
};

const MESSAGE: MailMessageRow = {
    id: 20,
    folder_id: 10,
    uid: 5,
    envelope_enc: 'server:{}',
    date: 1,
    seen: 1,
    flagged: 0,
    answered: 0,
    has_attachments: 1
};

/**
 * Un dépôt en mémoire : la chaîne message → dossier → compte, et la création
 * d'un compte. `projections` reproduit `item_shares`, la seconde branche de
 * `findVisible`.
 */
function fakeRepo(accountRows: MailAccountRow[], projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const visible = (a: MailAccountRow, ws: number) =>
        a.workspace_id === ws || (a.security_tier === 'open' && (projections[a.id] ?? []).includes(ws));
    return {
        accountRows,
        accounts: {
            listByWorkspace: unused,
            listVisible: unused,
            findById: async (id, ws) => accountRows.find((a) => a.id === id && a.workspace_id === ws) ?? null,
            findVisible: async (id, ws) => accountRows.find((a) => a.id === id && visible(a, ws)) ?? null,
            findByIdUnscoped: unused,
            async create({ userId, workspaceId, ...c }) {
                const row = account({
                    id: ++seq,
                    user_id: userId,
                    workspace_id: workspaceId,
                    display_name_enc: c.displayNameEnc,
                    email_address_enc: c.emailAddressEnc,
                    security_tier: c.securityTier,
                    auth_method: c.authMethod,
                    credentials_enc: c.credentialsEnc,
                    enabled: c.enabled ? 1 : 0,
                    sync_interval_seconds: c.syncIntervalSeconds
                });
                accountRows.push(row);
                return row;
            },
            update: unused,
            setEnabled: unused,
            delete: unused,
            reorder: unused,
            recordSync: unused,
            recordStatus: unused,
            updateCredentials: unused,
            updateSyncError: unused,
            listSyncDue: unused
        },
        folders: {
            listByAccount: unused,
            findById: async (id) => (id === FOLDER.id ? FOLDER : null),
            findByImapPath: unused,
            upsert: unused,
            updateCounts: unused,
            reorder: unused,
            updateNameEnc: unused
        },
        messages: {
            countByFolder: unused,
            minUidByFolder: unused,
            listByFolder: unused,
            findById: async (id) => (id === MESSAGE.id ? MESSAGE : null),
            listAllByFolder: unused,
            listForSearch: unused,
            listByFolderUids: unused,
            listFlagsWindow: unused,
            updateEnvelopeEnc: unused,
            upsertEnvelope: unused,
            setFlags: unused,
            updateFlags: unused,
            moveFolder: unused,
            delete: unused,
            deleteByFolder: unused,
            deleteByFolderUids: unused
        },
        settings: { get: unused, set: unused }
    };
}

/**
 * Un codec qui étiquette son étage : le harnais rend les deux étages d'un ticket
 * à l'identité, ce qui ne dirait pas sous lequel une route a lu ou écrit.
 * `deps.cipherFor` étiquette par espace (`server` pour l'espace 1 des fixtures,
 * `ws<n>` pour tout autre), de sorte qu'une pièce lue sous le codec du ticket
 * plutôt que sous celui du domicile du compte se voit.
 */
function taggedCipher(tag: string): SdkCipher {
    return {
        encrypt: async (plain) => `${tag}:${plain}`,
        decrypt: async (blob) => {
            if (!blob.startsWith(`${tag}:`)) throw new Error(`pas sous ${tag}`);
            return blob.slice(tag.length + 1);
        },
        tryDecrypt: async (blob) => (blob.startsWith(`${tag}:`) ? blob.slice(tag.length + 1) : null)
    };
}

function tagging(deps: TestServiceDeps<FakeRepo>): TestServiceDeps<FakeRepo> {
    const redeem = deps.secrecy.redeem;
    deps.secrecy = {
        redeem: async (ticket) => {
            const t = await redeem(ticket);
            if (!t) return null;
            return {
                ...t,
                cipher: { server: taggedCipher('server'), private: t.cipher.private ? taggedCipher('private') : null }
            };
        }
    };
    deps.cipherFor = (workspaceId) => taggedCipher(workspaceId === 1 ? 'server' : `ws${workspaceId}`);
    return deps;
}

/** Un ticket tel que `createTestContext().secrecy.ticket` le pose, verrou compris. */
function ticket(payload: unknown, unlocked = true, workspaceId = 1): string {
    return `ticket:${JSON.stringify({ userId: 1, workspaceId, payload, unlocked })}`;
}

/** Un message brut avec une pièce jointe, tel qu'IMAP le rendrait. */
const RAW = Buffer.from(
    [
        'From: a@exemple.fr',
        'To: moi@exemple.fr',
        'Subject: Rapport',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="B"',
        '',
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Bonjour',
        '--B',
        'Content-Type: application/pdf; name="rapport.pdf"',
        'Content-Disposition: attachment; filename="rapport.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4 test').toString('base64'),
        '--B--',
        ''
    ].join('\r\n')
);

function mount(accounts: MailAccountRow[] = [account({ id: 1 })], projections: Record<number, number[]> = {}) {
    const repo = fakeRepo(accounts, projections);
    const deps = tagging(
        createTestServiceDeps({ repo, origins: { app: 'https://app.test', public: 'https://p.test' } })
    );
    const fetched: { imapPath: string; uid: number }[] = [];
    const exchanged: { provider: string; code: string; appOrigin: string }[] = [];
    const { app, routes } = fakeApp();
    mailRoutes(app, deps, {
        client: {
            fetchMessageRaw: async (_credentials, imapPath, uid) => {
                fetched.push({ imapPath, uid });
                return RAW;
            }
        },
        oauth: {
            exchangeCodeForTokens: async (provider, code, appOrigin) => {
                exchanged.push({ provider, code, appOrigin });
                return {
                    accessToken: 'access',
                    refreshToken: 'refresh',
                    expiresAt: Date.now() + 3_600_000,
                    scope: 'mail',
                    email: 'moi@gmail.com'
                };
            }
        }
    });
    const routeOf = (path: string) => {
        const route = routes.find((r) => r.method === 'get' && r.path === path);
        assert.ok(route, `route GET ${path} manquante`);
        return route;
    };
    const call = async (path: string, query: Record<string, string>) => {
        const { reply, state } = fakeReply();
        await routeOf(path).handler({ headers: {}, body: undefined, query, ip: '127.0.0.1' }, reply);
        return state;
    };
    return { repo, deps, routes, fetched, exchanged, call };
}

describe('la déclaration', () => {
    it('déclare les deux GET sur l’origine de l’app seulement, sans plafond propre', () => {
        const { routes } = mount();
        assert.deepEqual(
            routes.map((r) => [r.method, r.path, r.opts]),
            [
                ['get', '/api/mail/attachment', { exposure: 'app' }],
                ['get', '/api/mail/oauth/callback', { exposure: 'app' }]
            ]
        );
    });
});

describe('GET /api/mail/attachment', () => {
    it('sans ticket, 400 ; avec un ticket invalide, 401 ; rien n’atteint IMAP', async () => {
        const { call, fetched } = mount();
        assert.equal((await call('/api/mail/attachment', {})).status, 400);
        assert.equal((await call('/api/mail/attachment', { token: 'nimporte' })).status, 401);
        // Un ticket valide dont la charge n'est pas celle d'une pièce jointe.
        assert.equal((await call('/api/mail/attachment', { token: ticket({ provider: 'google' }) })).status, 401);
        assert.deepEqual(fetched, []);
    });

    it('avec un ticket valide, rend les octets de la pièce, typés et nommés, lus sous le codec ouvert', async () => {
        const { call, fetched } = mount();
        const state = await call('/api/mail/attachment', {
            token: ticket({ messageId: 20, attachmentId: 'att-0' })
        });
        assert.equal(state.status, 200);
        assert.deepEqual(fetched, [{ imapPath: 'INBOX', uid: 5 }]);
        assert.ok(Buffer.isBuffer(state.payload));
        assert.equal((state.payload as Buffer).toString(), '%PDF-1.4 test');
        assert.equal(state.headers['Content-Type'], 'application/pdf');
        assert.equal(state.headers['Content-Length'], String(Buffer.byteLength('%PDF-1.4 test')));
        assert.equal(
            state.headers['Content-Disposition'],
            `attachment; filename="rapport.pdf"; filename*=UTF-8''rapport.pdf`
        );
    });

    it('une pièce inconnue du message rend 404 ; un message d’un autre espace, 404 aussi', async () => {
        const { call } = mount();
        assert.equal(
            (await call('/api/mail/attachment', { token: ticket({ messageId: 20, attachmentId: 'att-9' }) })).status,
            404
        );
        assert.equal(
            (await call('/api/mail/attachment', { token: ticket({ messageId: 20, attachmentId: 'att-0' }, true, 7) }))
                .status,
            404
        );
    });

    it('la pièce d’un compte projeté se sert sous le codec ouvert de son domicile, et seulement là où il est projeté', async () => {
        // Le compte 1 vit dans l'espace 42 (contenu sous `ws42`) et se projette
        // vers l'espace 1. Le ticket est posé dans l'espace 1 : son étage ouvert
        // (`server`) ne lirait pas la boîte.
        const home = account({ id: 1, workspace_id: 42 });
        const projected: MailAccountRow = {
            ...home,
            display_name_enc: home.display_name_enc.replace(/^server:/, 'ws42:'),
            email_address_enc: home.email_address_enc.replace(/^server:/, 'ws42:'),
            credentials_enc: home.credentials_enc.replace(/^server:/, 'ws42:')
        };
        const window = mount([projected], { 1: [1] });
        const served = await window.call('/api/mail/attachment', {
            token: ticket({ messageId: 20, attachmentId: 'att-0' })
        });
        assert.equal(served.status, 200);
        assert.deepEqual(window.fetched, [{ imapPath: 'INBOX', uid: 5 }]);
        assert.equal((served.payload as Buffer).toString(), '%PDF-1.4 test');

        const elsewhere = mount([projected], { 1: [1] });
        const refused = await elsewhere.call('/api/mail/attachment', {
            token: ticket({ messageId: 20, attachmentId: 'att-0' }, true, 9)
        });
        assert.equal(refused.status, 404);
        assert.deepEqual(elsewhere.fetched, []);
    });

    it('un compte gardé se lit sous le codec gardé, et une session verrouillée entre-temps est refusée', async () => {
        const guarded = mount([account({ id: 1, security_tier: 'guarded' })]);
        const ok = await guarded.call('/api/mail/attachment', {
            token: ticket({ messageId: 20, attachmentId: 'att-0' })
        });
        assert.equal(ok.status, 200);
        assert.equal(guarded.fetched.length, 1);

        const locked = mount([account({ id: 1, security_tier: 'guarded' })]);
        const refused = await locked.call('/api/mail/attachment', {
            token: ticket({ messageId: 20, attachmentId: 'att-0' }, false)
        });
        assert.equal(refused.status, 401);
        assert.deepEqual(refused.payload, { error: 'locked' });
        assert.deepEqual(locked.fetched, []);
    });
});

describe('GET /api/mail/oauth/callback', () => {
    it('avec un `state` valide, crée le compte sous le codec de son palier et referme la fenêtre vers l’app', async () => {
        const { call, repo, deps, exchanged } = mount([]);
        const state = await call('/api/mail/oauth/callback', {
            code: 'code-1',
            state: ticket({ provider: 'google', securityTier: 'open' })
        });
        assert.equal(state.status, 200);
        assert.equal(state.headers['Content-Type'], 'text/html; charset=utf-8');
        assert.deepEqual(exchanged, [{ provider: 'google', code: 'code-1', appOrigin: 'https://app.test' }]);

        assert.equal(repo.accountRows.length, 1);
        const row = repo.accountRows[0];
        assert.equal(row.auth_method, 'oauth_google');
        assert.equal(row.security_tier, 'open');
        assert.equal(row.workspace_id, 1);
        assert.equal(row.email_address_enc, 'server:moi@gmail.com');
        assert.equal(row.display_name_enc, 'server:moi@gmail.com');
        assert.ok(row.credentials_enc.startsWith('server:'));
        assert.equal(JSON.parse(row.credentials_enc.slice('server:'.length)).refreshToken, 'refresh');

        const html = String(state.payload);
        assert.ok(html.includes('window.opener.postMessage('));
        assert.ok(html.includes('"https://app.test"'));
        assert.ok(html.includes('"ok":true'));
        assert.ok(html.includes('window.close()'));
        assert.equal(deps.recorded.audits.at(-1)?.action, 'mail.oauthConnect');
    });

    it('un compte gardé s’écrit sous le codec gardé ; une session verrouillée entre-temps échoue sans écrire', async () => {
        const open = mount([]);
        await open.call('/api/mail/oauth/callback', {
            code: 'code-2',
            state: ticket({ provider: 'google', securityTier: 'guarded' })
        });
        assert.equal(open.repo.accountRows[0]?.security_tier, 'guarded');
        assert.ok(open.repo.accountRows[0]?.credentials_enc.startsWith('private:'));

        const locked = mount([]);
        const state = await locked.call('/api/mail/oauth/callback', {
            code: 'code-3',
            state: ticket({ provider: 'google', securityTier: 'guarded' }, false)
        });
        assert.ok(String(state.payload).includes('"ok":false'));
        assert.ok(String(state.payload).includes('verrouillée'));
        assert.deepEqual(locked.exchanged, []);
        assert.equal(locked.repo.accountRows.length, 0);
    });

    it('un `state` invalide, une réponse incomplète ou un refus du fournisseur rendent la page d’échec, sans rien écrire', async () => {
        const { call, repo, exchanged } = mount([]);
        const queries: Record<string, string>[] = [
            { code: 'c', state: 'faux' },
            { code: 'c', state: ticket({ messageId: 20, attachmentId: 'att-0' }) },
            { state: ticket({ provider: 'google', securityTier: 'open' }) },
            { error: 'access_denied' }
        ];
        for (const query of queries) {
            const state = await call('/api/mail/oauth/callback', query);
            assert.equal(state.status, 200);
            const html = String(state.payload);
            assert.ok(html.includes('"ok":false'), html);
            assert.ok(html.includes('Échec de la connexion'));
        }
        // Le message d'erreur du fournisseur traverse échappé, jamais tel quel.
        const injected = await call('/api/mail/oauth/callback', { error: '<script>alert(1)</script>' });
        assert.ok(!String(injected.payload).includes('<script>alert'));
        assert.deepEqual(exchanged, []);
        assert.equal(repo.accountRows.length, 0);
    });
});

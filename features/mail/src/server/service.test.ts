import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MailAccountRow, MailFolderRow, MailMessageRow } from '../contracts/domain';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import type { MailCredentials, OutgoingMail, RemoteEnvelope } from './client';
import type { MailRepo } from './repo';
import { MailSync } from './service';
import type { SyncClient } from './sync';
import { createMailTransport } from './transport';

/**
 * La relève de fond et le transport des alertes, sur le harnais de service du
 * SDK : sans horloge ni réseau, le client IMAP est la couture de test.
 *
 * Ce qui mérite d'être tenu : un tour relève les comptes **dus** et eux seuls
 * (ouverts, actifs, à échéance), met les dossiers et les enveloppes en cache
 * sous le codec ouvert, consigne la relève et ne prévient les écrans que
 * quand quelque chose a bougé ; une boîte qui ne répond pas est abandonnée à
 * l'échéance, consignée `unreachable`, annoncée, et rendue à la rotation ;
 * un compte gardé n'est jamais touché. Le transport ne liste que les comptes
 * ouverts et actifs visibles de l'espace (un compte projeté d'ailleurs en
 * fait partie, lu sous le codec de son domicile), envoie depuis l'adresse du
 * compte, et répond `false` plutôt que de lever.
 */

interface FakeRepo extends MailRepo {
    accountRows: MailAccountRow[];
    folderRows: MailFolderRow[];
    messageRows: MailMessageRow[];
    synced: { id: number; status: string; error: string | null }[];
}

async function unused(): Promise<never> {
    throw new Error('non attendu ici');
}

const CREDENTIALS: MailCredentials = {
    kind: 'password',
    imap: { host: 'imap.exemple.fr', port: 993, username: 'moi', password: 'x' },
    smtp: { host: 'smtp.exemple.fr', port: 465, username: 'moi', password: 'x' },
    proxy: null
};

/** Un compte en base, en clair : le harnais chiffre à l'identité. */
function account(over: Partial<MailAccountRow> & { id: number }): MailAccountRow {
    return {
        user_id: 1,
        workspace_id: 1,
        sort_order: 0,
        display_name_enc: `Compte ${over.id}`,
        email_address_enc: `c${over.id}@exemple.fr`,
        security_tier: 'open',
        auth_method: 'password',
        enabled: 1,
        sync_interval_seconds: 600,
        last_sync_at: null,
        last_sync_error_enc: null,
        last_sync_status: 'ok',
        last_error_at: null,
        credentials_enc: JSON.stringify(CREDENTIALS),
        created: 1,
        ...over
    };
}

/**
 * Un dépôt en mémoire : ce que la relève et le transport traversent.
 * `projections` reproduit `item_shares` (`accountId → espaces où il est
 * projeté`), la seconde branche de `listVisible` / `findVisible`.
 */
function fakeRepo(accountRows: MailAccountRow[], projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 0;
    const folderRows: MailFolderRow[] = [];
    const messageRows: MailMessageRow[] = [];
    const synced: FakeRepo['synced'] = [];
    const visible = (a: MailAccountRow, ws: number) =>
        a.workspace_id === ws || (a.security_tier === 'open' && (projections[a.id] ?? []).includes(ws));
    const repo: FakeRepo = {
        accountRows,
        folderRows,
        messageRows,
        synced,
        accounts: {
            // Des copies, comme une lecture SQL : la ligne que le service tient
            // est un instantané, `recordSync` n'a pas à le faire bouger.
            listByWorkspace: async (ws) => accountRows.filter((a) => a.workspace_id === ws).map((a) => ({ ...a })),
            listVisible: async (ws) => accountRows.filter((a) => visible(a, ws)).map((a) => ({ ...a })),
            findById: async (id, ws) => {
                const row = accountRows.find((a) => a.id === id && a.workspace_id === ws);
                return row ? { ...row } : null;
            },
            findVisible: async (id, ws) => {
                const row = accountRows.find((a) => a.id === id && visible(a, ws));
                return row ? { ...row } : null;
            },
            findByIdUnscoped: async (id) => {
                const row = accountRows.find((a) => a.id === id);
                return row ? { ...row } : null;
            },
            create: unused,
            update: unused,
            setEnabled: unused,
            delete: unused,
            reorder: unused,
            // Comme la vraie requête : ouverts, actifs, à échéance.
            listSyncDue: async (now, limit) =>
                accountRows
                    .filter(
                        (a) =>
                            a.enabled === 1 &&
                            a.security_tier === 'open' &&
                            (a.last_sync_at === null || a.last_sync_at <= now - a.sync_interval_seconds)
                    )
                    .slice(0, limit)
                    .map((a) => ({ ...a })),
            async recordSync(id, lastSyncAt, errorEnc, status) {
                const row = accountRows.find((a) => a.id === id);
                if (!row) return;
                row.last_sync_at = lastSyncAt;
                row.last_sync_error_enc = errorEnc;
                row.last_sync_status = status;
                synced.push({ id, status, error: errorEnc });
            },
            recordStatus: unused,
            updateCredentials: unused,
            updateSyncError: unused
        },
        folders: {
            listByAccount: async (accountId) => folderRows.filter((f) => f.account_id === accountId),
            findById: unused,
            findByImapPath: async (accountId, imapPath) =>
                folderRows.find((f) => f.account_id === accountId && f.imap_path === imapPath) ?? null,
            async upsert(input) {
                const existing = folderRows.find(
                    (f) => f.account_id === input.accountId && f.imap_path === input.imapPath
                );
                if (existing) {
                    existing.name_enc = input.nameEnc;
                    return existing;
                }
                const row: MailFolderRow = {
                    id: ++seq,
                    account_id: input.accountId,
                    imap_path: input.imapPath,
                    name_enc: input.nameEnc,
                    special_use: input.specialUse,
                    sort_order: folderRows.length,
                    uid_validity: input.uidValidity,
                    last_seen_uid: null,
                    first_seen_uid: null,
                    unread_count: 0,
                    total_count: 0
                };
                folderRows.push(row);
                return row;
            },
            async updateCounts(id, input) {
                const row = folderRows.find((f) => f.id === id);
                if (!row) return;
                row.uid_validity = input.uidValidity;
                row.last_seen_uid = input.lastSeenUid;
                row.first_seen_uid = input.firstSeenUid;
                row.unread_count = input.unreadCount;
                row.total_count = input.totalCount;
            },
            reorder: unused,
            updateNameEnc: unused
        },
        messages: {
            countByFolder: async (folderId) => {
                const rows = messageRows.filter((m) => m.folder_id === folderId);
                return { total: rows.length, unseen: rows.filter((m) => m.seen === 0).length };
            },
            minUidByFolder: async (folderId) => {
                const uids = messageRows.filter((m) => m.folder_id === folderId).map((m) => m.uid);
                return uids.length > 0 ? Math.min(...uids) : null;
            },
            listByFolder: unused,
            findById: unused,
            listAllByFolder: unused,
            listForSearch: unused,
            listByFolderUids: unused,
            listFlagsWindow: async (folderId, limit) =>
                messageRows
                    .filter((m) => m.folder_id === folderId)
                    .sort((a, b) => b.uid - a.uid)
                    .slice(0, limit),
            updateEnvelopeEnc: unused,
            async upsertEnvelope(input) {
                const existing = messageRows.find((m) => m.folder_id === input.folderId && m.uid === input.uid);
                if (existing) return existing;
                const row: MailMessageRow = {
                    id: ++seq,
                    folder_id: input.folderId,
                    uid: input.uid,
                    envelope_enc: input.envelopeEnc,
                    date: input.date,
                    seen: input.seen ? 1 : 0,
                    flagged: input.flagged ? 1 : 0,
                    answered: input.answered ? 1 : 0,
                    has_attachments: input.hasAttachments ? 1 : 0
                };
                messageRows.push(row);
                return row;
            },
            setFlags: unused,
            async updateFlags(id, flags) {
                const row = messageRows.find((m) => m.id === id);
                if (!row) return;
                row.seen = flags.seen ? 1 : 0;
                row.flagged = flags.flagged ? 1 : 0;
                row.answered = flags.answered ? 1 : 0;
            },
            moveFolder: unused,
            delete: unused,
            deleteByFolder: unused,
            async deleteByFolderUids(folderId, uids) {
                const before = messageRows.length;
                for (let i = messageRows.length - 1; i >= 0; i--) {
                    if (messageRows[i].folder_id === folderId && uids.includes(messageRows[i].uid)) {
                        messageRows.splice(i, 1);
                    }
                }
                return before - messageRows.length;
            }
        },
        settings: { get: unused, set: unused }
    };
    return repo;
}

function envelope(uid: number): RemoteEnvelope {
    return {
        uid,
        subject: `Message ${uid}`,
        from: { name: null, address: 'a@exemple.fr' },
        to: [],
        date: 1000 + uid,
        seen: false,
        flagged: false,
        answered: false,
        hasAttachments: false
    };
}

/** Un client IMAP sans réseau : un dossier, et les arrivées qu'on lui donne. */
function fakeClient(arrivals: RemoteEnvelope[]): SyncClient & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        listFolders: async () => {
            calls.push('listFolders');
            return [{ imapPath: 'INBOX', name: 'Boîte de réception', specialUse: 'inbox' }];
        },
        syncFolder: async ({ sinceUid, reconcile }) => {
            calls.push(`syncFolder:${sinceUid ?? 'first'}`);
            const messages = arrivals.filter((m) => sinceUid === null || m.uid > sinceUid);
            // La fenêtre relue : tout ce qu'on a encore, drapeaux inchangés.
            const reconciled = reconcile
                ? arrivals
                      .filter((m) => m.uid >= reconcile.fromUid && m.uid <= reconcile.toUid)
                      .map((m) => ({ uid: m.uid, seen: m.seen, flagged: m.flagged, answered: m.answered }))
                : null;
            return { uidValidity: 1, messages, reconciled };
        },
        fetchOlderMessages: async () => {
            calls.push('fetchOlderMessages');
            return { messages: [], reachedStart: true };
        }
    };
}

describe('la relève de fond', () => {
    it('pose un ticker à la cadence de l’environnement, et un tour relève les comptes dus sous le codec ouvert', async () => {
        const repo = fakeRepo([
            account({ id: 1 }),
            account({ id: 2, workspace_id: 2, security_tier: 'guarded' }),
            account({ id: 3, workspace_id: 2, enabled: 0 }),
            // Relevée il y a une minute, pour dix minutes de cadence : pas due.
            account({ id: 4, workspace_id: 2, last_sync_at: Math.floor(Date.now() / 1000) - 60 })
        ]);
        const deps = createTestServiceDeps({ repo });
        const client = fakeClient([envelope(1), envelope(2)]);
        new MailSync(deps, { mailClient: client });
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [120_000]
        );

        await deps.recorded.tickers[0].tick();

        // Le seul compte dû : le premier. Ses dossiers et ses enveloppes sont
        // en cache, la relève est consignée, et l'espace prévenu.
        assert.deepEqual(client.calls, ['listFolders', 'syncFolder:first']);
        assert.deepEqual(
            repo.folderRows.map((f) => [f.account_id, f.imap_path, f.name_enc, f.last_seen_uid, f.total_count]),
            [[1, 'INBOX', 'Boîte de réception', 2, 2]]
        );
        assert.deepEqual(
            repo.messageRows.map((m) => [m.uid, JSON.parse(m.envelope_enc).subject]),
            [
                [1, 'Message 1'],
                [2, 'Message 2']
            ]
        );
        assert.deepEqual(repo.synced, [{ id: 1, status: 'ok', error: null }]);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
        assert.equal(repo.accountRows[0].last_sync_status, 'ok');
    });

    it('un tour sans arrivée ne prévient personne ; une arrivée oui', async () => {
        const repo = fakeRepo([account({ id: 1 })]);
        const deps = createTestServiceDeps({ repo });
        const arrivals = [envelope(1)];
        const sync = new MailSync(deps, { mailClient: fakeClient(arrivals) });
        await sync.syncOne(1);
        assert.deepEqual(deps.recorded.liveChanges, [1]);

        await sync.syncOne(1);
        assert.deepEqual(deps.recorded.liveChanges, [1]);

        arrivals.push(envelope(2));
        await sync.syncOne(1);
        assert.deepEqual(deps.recorded.liveChanges, [1, 1]);
        assert.equal(repo.folderRows[0].last_seen_uid, 2);
        assert.equal(repo.messageRows.length, 2);
    });

    it('un compte gardé ou en pause n’est jamais relevé, même demandé par son identifiant', async () => {
        const repo = fakeRepo([account({ id: 1, security_tier: 'guarded' }), account({ id: 2, enabled: 0 })]);
        const deps = createTestServiceDeps({ repo });
        const client = fakeClient([envelope(1)]);
        const sync = new MailSync(deps, { mailClient: client });
        await sync.syncOne(1);
        await sync.syncOne(2);
        await sync.syncOne(99);
        assert.deepEqual(client.calls, []);
        assert.deepEqual(repo.synced, []);
        assert.deepEqual(deps.recorded.liveChanges, []);
    });

    it('une boîte qui ne répond pas est abandonnée à l’échéance, consignée `unreachable`, annoncée, puis rendue à la rotation', async () => {
        const repo = fakeRepo([account({ id: 1 })]);
        const deps = createTestServiceDeps({ repo });
        const client: SyncClient = {
            // Répond bien après l'échéance : c'est le cas qu'`inFlight` seul ne
            // rendait jamais. (Un minuteur tenu, et non une promesse jamais
            // résolue : celui de l'échéance est `unref`, il ne retient pas le
            // processus de test à lui seul.)
            listFolders: () => new Promise((resolve) => setTimeout(() => resolve([]), 200)),
            syncFolder: unused,
            fetchOlderMessages: unused
        };
        const sync = new MailSync(deps, { mailClient: client, accountTimeoutMs: 20 });
        await sync.syncOne(1);

        assert.equal(repo.synced.length, 1);
        assert.equal(repo.synced[0].status, 'unreachable');
        assert.match(repo.synced[0].error ?? '', /n’a pas répondu à temps/);
        assert.equal(repo.accountRows[0].last_sync_status, 'unreachable');
        // La panne est annoncée une fois ; la suivante, identique, ne l'est pas.
        assert.deepEqual(deps.recorded.liveChanges, [1]);
        await sync.syncOne(1);
        assert.equal(repo.synced.length, 2);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('une panne qui se répare est annoncée : le retour au vert vaut d’être dit', async () => {
        const repo = fakeRepo([account({ id: 1, last_sync_status: 'auth', last_sync_error_enc: 'refusé' })]);
        const deps = createTestServiceDeps({ repo });
        const sync = new MailSync(deps, { mailClient: fakeClient([]) });
        await sync.syncOne(1);
        assert.deepEqual(repo.synced, [{ id: 1, status: 'ok', error: null }]);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });
});

describe('le transport des alertes', () => {
    function transportWith(accounts: MailAccountRow[], fail = false, projections: Record<number, number[]> = {}) {
        const repo = fakeRepo(accounts, projections);
        const deps = createTestServiceDeps({ repo });
        // Les espaces dont le codec ouvert a été demandé : le harnais rend
        // l'identité pour tous, seul l'appel dit lequel le transport a choisi.
        const ciphersAsked: number[] = [];
        const cipherFor = deps.cipherFor;
        deps.cipherFor = (workspaceId) => {
            ciphersAsked.push(workspaceId);
            return cipherFor(workspaceId);
        };
        const sent: { credentials: MailCredentials; message: OutgoingMail }[] = [];
        const transport = createMailTransport(deps, {
            sendMail: async (credentials, message) => {
                sent.push({ credentials, message });
                if (fail) throw new Error('SMTP : connexion refusée');
                return { messageId: '<id@exemple.fr>' };
            }
        });
        return { transport, sent, ciphersAsked };
    }

    it('ne liste que les comptes ouverts et actifs, avec leur libellé et leur adresse', async () => {
        const { transport } = transportWith([
            account({ id: 1 }),
            account({ id: 2, security_tier: 'guarded' }),
            account({ id: 3, enabled: 0 }),
            account({ id: 4, workspace_id: 2 })
        ]);
        assert.deepEqual(await transport.listSenders(1), [{ id: 1, label: 'Compte 1', address: 'c1@exemple.fr' }]);
        assert.deepEqual(await transport.listSenders(2), [{ id: 4, label: 'Compte 4', address: 'c4@exemple.fr' }]);
        assert.equal(await transport.isReady(1, 1), true);
        assert.equal(await transport.isReady(2, 1), false);
        assert.equal(await transport.isReady(3, 1), false);
        // Un compte d'un autre espace n'est pas prêt ICI.
        assert.equal(await transport.isReady(4, 1), false);
    });

    it('voit un compte projeté comme expéditeur de l’espace où il est projeté, sous le codec de son domicile', async () => {
        // Le compte 5 vit dans l'espace 42 et se projette vers l'espace 1 ; le
        // compte 6 aussi, mais en pause : projeté ou non, il ne part pas seul.
        const { transport, sent, ciphersAsked } = transportWith(
            [
                account({ id: 1 }),
                account({ id: 5, workspace_id: 42 }),
                account({ id: 6, workspace_id: 42, enabled: 0 })
            ],
            false,
            { 5: [1], 6: [1] }
        );
        assert.deepEqual(await transport.listSenders(1), [
            { id: 1, label: 'Compte 1', address: 'c1@exemple.fr' },
            { id: 5, label: 'Compte 5', address: 'c5@exemple.fr' }
        ]);
        assert.equal(await transport.isReady(5, 1), true);
        assert.equal(await transport.isReady(6, 1), false);
        // Là où il n'est pas projeté, il n'est pas prêt.
        assert.equal(await transport.isReady(5, 9), false);

        ciphersAsked.length = 0;
        assert.equal(
            await transport.send(5, 1, { to: 'astreinte@exemple.fr', subject: 'Alerte', text: 'corps' }),
            true
        );
        assert.equal(sent.length, 1);
        assert.equal(sent[0].message.from, 'c5@exemple.fr');
        // Lu sous le codec de SON espace, jamais sous celui du canal.
        assert.ok(ciphersAsked.includes(42));
        assert.ok(!ciphersAsked.includes(1));
    });

    it('envoie depuis l’adresse du compte, par le client, et répond vrai', async () => {
        const { transport, sent } = transportWith([account({ id: 1 })]);
        const ok = await transport.send(1, 1, { to: 'astreinte@exemple.fr', subject: 'Alerte', text: 'corps' });
        assert.equal(ok, true);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].credentials, CREDENTIALS);
        assert.deepEqual(sent[0].message, {
            from: 'c1@exemple.fr',
            to: [{ name: null, address: 'astreinte@exemple.fr' }],
            subject: 'Alerte',
            text: 'corps'
        });
    });

    it('répond faux, sans lever, sur un compte non prêt ou un envoi qui échoue', async () => {
        const refused = transportWith([account({ id: 1, security_tier: 'guarded' }), account({ id: 2, enabled: 0 })]);
        const message = { to: 'x@exemple.fr', subject: 's', text: 't' };
        assert.equal(await refused.transport.send(1, 1, message), false);
        assert.equal(await refused.transport.send(2, 1, message), false);
        assert.equal(await refused.transport.send(9, 1, message), false);
        assert.deepEqual(refused.sent, []);

        const failing = transportWith([account({ id: 1 })], true);
        assert.equal(await failing.transport.send(1, 1, message), false);
        assert.equal(failing.sent.length, 1);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    mailAccountAdd,
    mailAccountCount,
    mailAccountDelete,
    mailAccountList,
    mailAccountSetEnabled,
    mailAccountSetProfile,
    mailAccountUpdate,
    mailAttachmentDownload,
    mailFolderList,
    mailGetSettings,
    mailMessageList,
    mailOAuthStart,
    mailSetSettings
} from '../contracts/commands';
import type {
    MailAccountDraft,
    MailAccountRow,
    MailFolderRow,
    MailMessageRow,
    MailSettingsRow
} from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, type TestContext } from '@deveye/types/sdk/testing';

import type { MailRepo } from './repo';

/**
 * Les handlers du module, sur le harnais du SDK. Ce qui se tient ici est ce qui
 * ne lève nulle part quand ça se dérègle : le codec choisi par palier, le
 * verrou, les secrets absents des DTO, la charge des deux tickets, et le partage
 * inter-espaces (codec du domicile, gestes réservés au domicile).
 *
 * `OAUTH_GOOGLE_*` est posé AVANT le chargement des handlers, parce que `env.ts`
 * lit l'environnement à l'import : c'est la raison de l'import dynamique.
 */

process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client';
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret';
delete process.env.OAUTH_MICROSOFT_CLIENT_ID;
const { mailHandlers } = await import('./handlers');
const { serverEntry } = await import('./index');

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = mailHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<MailRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

interface FakeRepo extends MailRepo {
    accountRows: MailAccountRow[];
    folderRows: MailFolderRow[];
    messageRows: MailMessageRow[];
}

async function unused(): Promise<never> {
    throw new Error('non attendu ici');
}

/** Un compte en base, tel que le vrai dépôt le rendrait ; le contenu est celui que le codec de son domicile lit. */
function row(over: Partial<MailAccountRow> & { id: number; workspace_id: number }): MailAccountRow {
    return {
        user_id: 1,
        sort_order: over.id,
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
        credentials_enc: JSON.stringify({
            kind: 'password',
            imap: { host: 'imap.ailleurs.fr', port: 993, username: 'x', password: 'x' },
            smtp: { host: 'smtp.ailleurs.fr', port: 465, username: 'x', password: 'x' },
            proxy: null
        }),
        created: 1,
        ...over
    };
}

/**
 * Un dépôt en mémoire, même contrat que le vrai : ce que ces tests traversent
 * est implémenté, le reste lève s'il est atteint. `projections` reproduit
 * `item_shares` (`accountId → espaces où il est projeté`), la seconde branche de
 * `listVisible` / `findVisible`, dont le harnais (`shares`) doit dire l'écho
 * pour que `ctx.sharing.scope()` connaisse le domicile.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 0;
    const accountRows: MailAccountRow[] = [];
    const folderRows: MailFolderRow[] = [];
    const messageRows: MailMessageRow[] = [];
    let settings: MailSettingsRow | null = null;
    const projected = (a: MailAccountRow, ws: number) =>
        a.security_tier === 'open' && (projections[a.id] ?? []).includes(ws);
    const visible = (a: MailAccountRow, ws: number) => a.workspace_id === ws || projected(a, ws);
    // Des copies, comme une lecture SQL : la ligne qu'un handler tient est un
    // instantané qu'une écriture ne doit pas faire bouger sous lui.
    const copy = (a: MailAccountRow | undefined): MailAccountRow | null => (a ? { ...a } : null);
    return {
        accountRows,
        folderRows,
        messageRows,
        accounts: {
            listByWorkspace: async (ws) => accountRows.filter((a) => a.workspace_id === ws).map((a) => ({ ...a })),
            // Les locaux d'abord, les projetés ensuite : l'ordre de la requête.
            listVisible: async (ws) =>
                [
                    ...accountRows.filter((a) => a.workspace_id === ws),
                    ...accountRows.filter((a) => projected(a, ws))
                ].map((a) => ({ ...a })),
            findById: async (id, ws) => copy(accountRows.find((a) => a.id === id && a.workspace_id === ws)),
            findVisible: async (id, ws) => copy(accountRows.find((a) => a.id === id && visible(a, ws))),
            findByIdUnscoped: async (id) => copy(accountRows.find((a) => a.id === id)),
            async create({ userId, workspaceId, ...c }) {
                const created = row({
                    id: ++seq,
                    user_id: userId,
                    workspace_id: workspaceId,
                    sort_order: accountRows.length,
                    display_name_enc: c.displayNameEnc,
                    email_address_enc: c.emailAddressEnc,
                    security_tier: c.securityTier,
                    auth_method: c.authMethod,
                    enabled: c.enabled ? 1 : 0,
                    sync_interval_seconds: c.syncIntervalSeconds,
                    credentials_enc: c.credentialsEnc
                });
                accountRows.push(created);
                return created;
            },
            // Comme la vraie requête : une mise à jour adressée au mauvais
            // espace ne touche rien et rend `null`.
            async update(id, ws, c) {
                const target = accountRows.find((a) => a.id === id && a.workspace_id === ws);
                if (!target) return null;
                Object.assign(target, {
                    display_name_enc: c.displayNameEnc,
                    email_address_enc: c.emailAddressEnc,
                    security_tier: c.securityTier,
                    auth_method: c.authMethod,
                    credentials_enc: c.credentialsEnc,
                    enabled: c.enabled ? 1 : 0,
                    sync_interval_seconds: c.syncIntervalSeconds
                });
                return { ...target };
            },
            async setEnabled(id, ws, enabled) {
                const target = accountRows.find((a) => a.id === id && a.workspace_id === ws);
                if (!target) return null;
                target.enabled = enabled ? 1 : 0;
                return { ...target };
            },
            async delete(id, ws) {
                const index = accountRows.findIndex((a) => a.id === id && a.workspace_id === ws);
                if (index === -1) return false;
                accountRows.splice(index, 1);
                return true;
            },
            reorder: unused,
            recordSync: unused,
            recordStatus: unused,
            updateCredentials: unused,
            updateSyncError: unused,
            listSyncDue: unused
        },
        folders: {
            listByAccount: async (accountId) => folderRows.filter((f) => f.account_id === accountId),
            findById: async (id) => folderRows.find((f) => f.id === id) ?? null,
            findByImapPath: unused,
            upsert: unused,
            updateCounts: unused,
            reorder: unused,
            updateNameEnc: unused
        },
        messages: {
            countByFolder: unused,
            minUidByFolder: unused,
            listByFolder: async (folderId, _cursor, limit) =>
                messageRows
                    .filter((m) => m.folder_id === folderId)
                    .sort((a, b) => b.date - a.date || b.id - a.id)
                    .slice(0, limit),
            findById: async (id) => messageRows.find((m) => m.id === id) ?? null,
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
        settings: {
            get: async () => settings,
            async set(workspaceId, input) {
                settings = {
                    workspace_id: workspaceId,
                    external_scan_enabled_default: input.externalScanEnabledDefault ? 1 : 0,
                    trusted_image_domains:
                        input.trustedImageDomains.length > 0 ? JSON.stringify(input.trustedImageDomains) : null,
                    body_render_mode: input.bodyRenderMode
                };
                return settings;
            }
        }
    };
}

const DRAFT: MailAccountDraft = {
    displayName: 'Perso',
    emailAddress: 'moi@exemple.fr',
    securityTier: 'open',
    imap: { host: 'imap.exemple.fr', port: 993, username: 'moi', password: 'imap-s3cret' },
    smtp: { host: 'smtp.exemple.fr', port: 465, username: 'moi', password: 'smtp-s3cret' },
    proxy: null
};

/**
 * Un codec qui étiquette son étage : le harnais chiffre à l'identité, ce qui ne
 * dirait pas sous quel codec une ligne a été écrite.
 */
function taggedCipher(tag: string): SdkCipher {
    return {
        encrypt: async (plain) => `${tag}:${plain}`,
        decrypt: async (blob) => blob.slice(tag.length + 1),
        tryDecrypt: async (blob) => (blob.startsWith(`${tag}:`) ? blob.slice(tag.length + 1) : null)
    };
}

function tagging(ctx: TestContext<FakeRepo>): TestContext<FakeRepo> {
    ctx.cipher = (mode) => taggedCipher(mode ?? 'server');
    return ctx;
}

/** Le ticket du harnais, relu : `ticket:{ userId, workspaceId, payload, unlocked }`. */
function ticketPayload(ticket: string): unknown {
    assert.ok(ticket.startsWith('ticket:'), 'un ticket du harnais');
    return (JSON.parse(ticket.slice('ticket:'.length)) as { payload: unknown }).payload;
}

describe('mail.accountList / mail.accountCount', () => {
    it('liste les comptes de l’espace sans jamais rendre un secret, et compte par espace', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        await handlerFor(mailAccountAdd)(ctx, { draft: DRAFT });
        await handlerFor(mailAccountAdd)(ctx, {
            draft: { ...DRAFT, displayName: 'Pro', emailAddress: 'pro@exemple.fr' }
        });

        const listed = await handlerFor(mailAccountList)(ctx, {});
        assert.deepEqual(
            listed.accounts.map((a) => [a.displayName, a.emailAddress, a.securityTier, a.imapHost, a.enabled]),
            [
                ['Perso', 'moi@exemple.fr', 'open', 'imap.exemple.fr', true],
                ['Pro', 'pro@exemple.fr', 'open', 'imap.exemple.fr', true]
            ]
        );
        assert.ok(!JSON.stringify(listed).includes('s3cret'));

        assert.deepEqual(await handlerFor(mailAccountCount)(ctx, {}), { count: 2 });
        assert.deepEqual(await handlerFor(mailAccountCount)(createTestContext({ repo, workspaceId: 7 }), {}), {
            count: 0
        });
        assert.equal(ctx.recorded.audits[0]?.action, 'mail.accountAdd');
    });
});

describe('mail.accountAdd : les deux paliers', () => {
    it('un compte ouvert s’écrit sous le codec ouvert, dans un espace partagé comme personnel', async () => {
        const repo = fakeRepo();
        const ctx = tagging(createTestContext({ repo, kind: 'shared' }));
        const added = await handlerFor(mailAccountAdd)(ctx, { draft: DRAFT });
        assert.equal(added.account.securityTier, 'open');
        assert.ok(repo.accountRows[0].credentials_enc.startsWith('server:'));
        assert.ok(repo.accountRows[0].display_name_enc.startsWith('server:'));
        assert.deepEqual(JSON.parse(repo.accountRows[0].credentials_enc.slice('server:'.length)), {
            kind: 'password',
            imap: DRAFT.imap,
            smtp: DRAFT.smtp,
            proxy: null
        });
    });

    it('un compte gardé est refusé dans un espace partagé, sans rien écrire', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo, kind: 'shared' });
        await assert.rejects(
            handlerFor(mailAccountAdd)(ctx, { draft: { ...DRAFT, securityTier: 'guarded' } }),
            failsWith('validation')
        );
        assert.equal(repo.accountRows.length, 0);
    });

    it('un compte gardé s’écrit sous le codec gardé dans un espace personnel', async () => {
        const repo = fakeRepo();
        const ctx = tagging(createTestContext({ repo, kind: 'personal' }));
        const added = await handlerFor(mailAccountAdd)(ctx, { draft: { ...DRAFT, securityTier: 'guarded' } });
        assert.equal(added.account.securityTier, 'guarded');
        assert.equal(added.account.displayName, 'Perso');
        assert.ok(repo.accountRows[0].credentials_enc.startsWith('private:'));
        assert.ok(repo.accountRows[0].email_address_enc.startsWith('private:'));
    });
});

describe('le verrou', () => {
    it('une lecture sur un compte gardé répond `locked` à une session scellée ; la liste masque', async () => {
        const repo = fakeRepo();
        const added = await handlerFor(mailAccountAdd)(createTestContext({ repo }), {
            draft: { ...DRAFT, securityTier: 'guarded' }
        });

        const locked = createTestContext({ repo, unlocked: false });
        await assert.rejects(handlerFor(mailFolderList)(locked, { accountId: added.account.id }), failsWith('locked'));

        // La liste des comptes ne lève pas : le compte existe, son nom non.
        const listed = await handlerFor(mailAccountList)(locked, {});
        assert.equal(listed.accounts[0].displayName, '(compte verrouillé)');
        assert.equal(listed.accounts[0].emailAddress, '');
        assert.deepEqual(await handlerFor(mailAccountCount)(locked, {}), { count: 1 });
    });
});

describe('mail.attachmentDownload', () => {
    it('rend une URL de la route publique, portant un ticket dont la charge désigne la pièce', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const added = await handlerFor(mailAccountAdd)(ctx, { draft: DRAFT });
        repo.folderRows.push({
            id: 10,
            account_id: added.account.id,
            imap_path: 'INBOX',
            name_enc: 'Boîte de réception',
            special_use: 'inbox',
            sort_order: 0,
            uid_validity: 1,
            last_seen_uid: 5,
            first_seen_uid: 1,
            unread_count: 0,
            total_count: 1
        });
        repo.messageRows.push({
            id: 20,
            folder_id: 10,
            uid: 5,
            envelope_enc: JSON.stringify({ subject: 'Pièce', from: null, to: [], snippet: '' }),
            date: 1,
            seen: 1,
            flagged: 0,
            answered: 0,
            has_attachments: 1
        });

        const { downloadUrl } = await handlerFor(mailAttachmentDownload)(ctx, { messageId: 20, attachmentId: 'att-0' });
        const url = new URL(downloadUrl, 'https://deveye.test');
        assert.equal(url.pathname, '/api/mail/attachment');
        assert.deepEqual(ticketPayload(url.searchParams.get('token') ?? ''), { messageId: 20, attachmentId: 'att-0' });

        // Un message qui n'est pas dans la chaîne de l'espace : rien à signer.
        await assert.rejects(
            handlerFor(mailAttachmentDownload)(ctx, { messageId: 99, attachmentId: 'att-0' }),
            failsWith('not_found')
        );
        await assert.rejects(
            handlerFor(mailAttachmentDownload)(createTestContext({ repo, workspaceId: 7 }), {
                messageId: 20,
                attachmentId: 'att-0'
            }),
            failsWith('not_found')
        );
    });
});

describe('mail.oauthStart', () => {
    it('rend l’URL de consentement, `state` = ticket du fournisseur et du palier, retour sur l’origine de l’app', async () => {
        const ctx = createTestContext({
            repo: fakeRepo(),
            origins: { app: 'https://app.test', public: 'https://p.test' }
        });
        const { authUrl } = await handlerFor(mailOAuthStart)(ctx, {
            provider: 'google',
            securityTier: 'open',
            displayName: 'Perso Gmail',
            accountId: null
        });
        const url = new URL(authUrl);
        assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
        assert.equal(url.searchParams.get('client_id'), 'google-client');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://app.test/api/mail/oauth/callback');
        // Le nom saisi voyage avec le ticket : la route de callback crée le
        // compte hors session et n'a aucun autre moyen de le connaître.
        assert.deepEqual(ticketPayload(url.searchParams.get('state') ?? ''), {
            provider: 'google',
            securityTier: 'open',
            displayName: 'Perso Gmail',
            accountId: null
        });
    });

    it('refuse un fournisseur non configuré, et un compte gardé dans un espace partagé', async () => {
        const ctx = createTestContext({ repo: fakeRepo(), kind: 'shared' });
        await assert.rejects(
            handlerFor(mailOAuthStart)(ctx, {
                provider: 'microsoft',
                securityTier: 'open',
                displayName: '',
                accountId: null
            }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(mailOAuthStart)(ctx, {
                provider: 'google',
                securityTier: 'guarded',
                displayName: '',
                accountId: null
            }),
            failsWith('validation')
        );
    });
});

/** Un dossier en cache d'un compte, en clair : le codec de son domicile le lit tel quel. */
function folderRow(id: number, accountId: number): MailFolderRow {
    return {
        id,
        account_id: accountId,
        imap_path: 'INBOX',
        name_enc: 'Boîte de réception',
        special_use: 'inbox',
        sort_order: 0,
        uid_validity: 1,
        last_seen_uid: 5,
        first_seen_uid: 1,
        unread_count: 0,
        total_count: 1
    };
}

describe('le partage inter-espaces', () => {
    it('liste un compte projeté avec sa pastille `foreign`, sous le codec de son domicile, et le compte', async () => {
        // Le compte 7 vit dans l'espace 42 et se projette vers l'espace 1 : lire
        // la ligne projetée avec le codec étiqueté de la fenêtre rendrait
        // « (compte verrouillé) », celui du domicile rend son nom.
        const repo = fakeRepo({ 7: [1] });
        repo.accountRows.push(row({ id: 7, workspace_id: 42, display_name_enc: 'Ailleurs' }));
        const ctx = tagging(createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } }));
        await handlerFor(mailAccountAdd)(ctx, { draft: DRAFT });

        const listed = await handlerFor(mailAccountList)(ctx, {});
        assert.deepEqual(
            listed.accounts.map((a) => [a.id, a.displayName, a.imapHost, a.foreign]),
            [
                [1, 'Perso', 'imap.exemple.fr', false],
                [7, 'Ailleurs', 'imap.ailleurs.fr', true]
            ]
        );
        assert.ok(!JSON.stringify(listed).includes('s3cret'));
        assert.deepEqual(await handlerFor(mailAccountCount)(ctx, {}), { count: 2 });

        // Un compte masqué pour ce rôle disparaît de la liste et du compte.
        const hidden = tagging(
            createTestContext({ repo, workspaceId: 1, shares: { 7: 42 }, itemRestrictions: { 7: 'none' } })
        );
        assert.deepEqual(
            (await handlerFor(mailAccountList)(hidden, {})).accounts.map((a) => a.id),
            [1]
        );
        assert.deepEqual(await handlerFor(mailAccountCount)(hidden, {}), { count: 1 });

        // Depuis un espace où il n'est pas projeté, il n'existe pas.
        const elsewhere = createTestContext({ repo, workspaceId: 9 });
        assert.deepEqual((await handlerFor(mailAccountList)(elsewhere, {})).accounts, []);
    });

    it('lit les dossiers et les messages en cache d’un compte projeté, sous le codec de son domicile', async () => {
        const repo = fakeRepo({ 7: [1] });
        repo.accountRows.push(row({ id: 7, workspace_id: 42 }));
        repo.folderRows.push(folderRow(10, 7));
        repo.messageRows.push({
            id: 20,
            folder_id: 10,
            uid: 5,
            envelope_enc: JSON.stringify({ subject: 'Bonjour', from: null, to: [], snippet: '' }),
            date: 1,
            seen: 1,
            flagged: 0,
            answered: 0,
            has_attachments: 0
        });
        const window = tagging(createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } }));

        // Le cache est servi tel quel (compte ouvert, dossiers présents) : rien
        // ne part vers IMAP. Un mauvais codec rendrait le chemin IMAP en guise
        // de nom, et « (verrouillé) » en guise d'objet.
        const folders = await handlerFor(mailFolderList)(window, { accountId: 7 });
        assert.deepEqual(
            folders.folders.map((f) => [f.id, f.name]),
            [[10, 'Boîte de réception']]
        );
        const messages = await handlerFor(mailMessageList)(window, { folderId: 10, cursor: null, limit: 50 });
        assert.deepEqual(
            messages.messages.map((m) => [m.id, m.accountId, m.subject]),
            [[20, 7, 'Bonjour']]
        );

        // La chaîne message → dossier → compte remonte au compte : d'un espace
        // qui ne le voit pas, le dossier n'existe pas non plus.
        await assert.rejects(
            handlerFor(mailFolderList)(createTestContext({ repo, workspaceId: 9 }), { accountId: 7 }),
            failsWith('not_found')
        );
        await assert.rejects(
            handlerFor(mailMessageList)(createTestContext({ repo, workspaceId: 9 }), {
                folderId: 10,
                cursor: null,
                limit: 50
            }),
            failsWith('not_found')
        );
    });

    it('depuis la fenêtre : le nom, la cadence et la pause se règlent sous le codec du domicile ; la restriction mord', async () => {
        const repo = fakeRepo({ 7: [1] });
        repo.accountRows.push(row({ id: 7, workspace_id: 42 }));
        const window = tagging(createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } }));

        const renamed = await handlerFor(mailAccountSetProfile)(window, {
            id: 7,
            displayName: 'Renommée',
            securityTier: 'open',
            syncIntervalMinutes: 5
        });
        assert.equal(renamed.account.displayName, 'Renommée');
        assert.equal(renamed.account.foreign, true);
        // Réécrit chez lui (espace 42) et sous SON codec (l'identité du
        // harnais), pas sous le codec étiqueté de la fenêtre.
        assert.equal(repo.accountRows[0].workspace_id, 42);
        assert.equal(repo.accountRows[0].display_name_enc, 'Renommée');
        assert.equal(repo.accountRows[0].sync_interval_seconds, 300);

        const paused = await handlerFor(mailAccountSetEnabled)(window, { id: 7, enabled: false });
        assert.equal(paused.account.enabled, false);
        assert.equal(paused.account.foreign, true);
        assert.equal(repo.accountRows[0].enabled, 0);

        // Un rôle en lecture seule sur la ligne ne la met pas en pause.
        const readOnly = createTestContext({
            repo,
            workspaceId: 1,
            shares: { 7: 42 },
            itemRestrictions: { 7: 'read' }
        });
        await assert.rejects(
            handlerFor(mailAccountSetEnabled)(readOnly, { id: 7, enabled: true }),
            failsWith('forbidden')
        );
    });

    it('refuse depuis la fenêtre de supprimer, de changer le palier et de retoucher les identifiants ; le domicile le peut', async () => {
        const repo = fakeRepo({ 7: [1] });
        repo.accountRows.push(row({ id: 7, workspace_id: 42 }));
        const window = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });

        await assert.rejects(handlerFor(mailAccountDelete)(window, { id: 7 }), failsWith('validation'));
        await assert.rejects(
            handlerFor(mailAccountSetProfile)(window, {
                id: 7,
                displayName: 'Compte 7',
                securityTier: 'guarded',
                syncIntervalMinutes: 10
            }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(mailAccountSetProfile)(window, {
                id: 7,
                displayName: 'Compte 7',
                securityTier: 'open',
                syncIntervalMinutes: 10,
                proxy: null
            }),
            failsWith('validation')
        );
        await assert.rejects(handlerFor(mailAccountUpdate)(window, { id: 7, draft: DRAFT }), failsWith('validation'));
        assert.equal(repo.accountRows.length, 1);
        assert.equal(repo.accountRows[0].security_tier, 'open');
        assert.deepEqual(window.forgotten, []);

        // Chez lui : la ligne part, et avec elle projections, restrictions et
        // route de notification (`ctx.items.forget`).
        const home = createTestContext({ repo, workspaceId: 42 });
        assert.deepEqual(await handlerFor(mailAccountDelete)(home, { id: 7 }), { id: 7 });
        assert.equal(repo.accountRows.length, 0);
        assert.deepEqual(home.forgotten, ['7']);
        assert.equal(home.recorded.audits.at(-1)?.action, 'mail.accountDelete');
    });

    it('un compte projeté qui passe au palier gardé chez lui perd ses projections ; rouvrir ne les rend pas', async () => {
        const repo = fakeRepo({ 7: [1] });
        repo.accountRows.push(row({ id: 7, workspace_id: 42 }));
        const home = createTestContext({ repo, workspaceId: 42 });

        const guarded = await handlerFor(mailAccountSetProfile)(home, {
            id: 7,
            displayName: 'Compte 7',
            securityTier: 'guarded',
            syncIntervalMinutes: 10
        });
        assert.equal(guarded.account.securityTier, 'guarded');
        assert.equal(repo.accountRows[0].security_tier, 'guarded');
        // Projections et restrictions par élément partent avec le palier
        // (`ctx.items.forget`) : plus de ligne `item_shares` dormante.
        assert.deepEqual(home.forgotten, ['7']);

        // Le retour à l'étage ouvert ne touche à rien : il n'y a plus rien à
        // oublier, et un oubli de plus retirerait des restrictions posées depuis.
        await handlerFor(mailAccountSetProfile)(home, {
            id: 7,
            displayName: 'Compte 7',
            securityTier: 'open',
            syncIntervalMinutes: 10
        });
        assert.equal(repo.accountRows[0].security_tier, 'open');
        assert.deepEqual(home.forgotten, ['7']);
    });

    it('`items` : le domicile d’un compte visible, son intitulé, et un compte gardé qui ne se projette pas', async () => {
        const repo = fakeRepo({ 7: [1] });
        repo.accountRows.push(
            row({ id: 7, workspace_id: 42, display_name_enc: 'Ailleurs' }),
            row({ id: 8, workspace_id: 42, security_tier: 'guarded' }),
            row({ id: 9, workspace_id: 42, display_name_enc: '' })
        );
        const items = serverEntry.items;
        assert.ok(items);
        const open = createTestContext({ repo }).cipher('server');

        assert.equal(await items.homeOf(repo, '7', 42), 42);
        assert.equal(await items.homeOf(repo, '7', 1), 42);
        assert.equal(await items.homeOf(repo, '7', 9), null);

        assert.equal(await items.labelOf(repo, open, '7', 42), 'Ailleurs');
        // Sans nom, l'adresse ; disparu, rien.
        assert.equal(await items.labelOf(repo, open, '9', 42), 'c9@exemple.fr');
        assert.equal(await items.labelOf(repo, open, '99', 42), null);

        assert.ok(items.shareable);
        assert.equal(await items.shareable(repo, '7', 42), true);
        assert.equal(await items.shareable(repo, '8', 42), false);
        assert.equal(await items.shareable(repo, '99', 42), false);
    });
});

describe('mail.getSettings / mail.setSettings', () => {
    it('rend les défauts sans ligne, puis ce qui a été écrit', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        assert.deepEqual(await handlerFor(mailGetSettings)(ctx, {}), {
            settings: { externalScanEnabledDefault: false, trustedImageDomains: [], bodyRenderMode: 'embedded' }
        });

        const written = await handlerFor(mailSetSettings)(ctx, {
            externalScanEnabledDefault: true,
            trustedImageDomains: ['exemple.fr'],
            bodyRenderMode: 'raw'
        });
        assert.deepEqual(written.settings, {
            externalScanEnabledDefault: true,
            trustedImageDomains: ['exemple.fr'],
            bodyRenderMode: 'raw'
        });
        assert.deepEqual(await handlerFor(mailGetSettings)(ctx, {}), written);
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'mail.setSettings');
    });
});

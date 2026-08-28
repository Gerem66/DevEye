import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    mailAccountAdd,
    mailAccountCount,
    mailAccountList,
    mailAttachmentDownload,
    mailFolderList,
    mailGetSettings,
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
 * Les handlers du module, sur le harnais du SDK.
 *
 * Ce qui mérite d'être tenu, c'est ce qui ne lève nulle part quand ça se
 * dérègle : les **deux paliers** (un compte ouvert s'écrit sous le codec
 * ouvert, un compte gardé sous le codec gardé, et un compte gardé n'existe pas
 * dans un espace partagé), le **verrou** (une lecture sur un compte gardé
 * répond `locked` à une session scellée, et la liste des comptes masque au
 * lieu de lever), les **secrets** (jamais dans un DTO), les deux **tickets**
 * (l'URL d'une pièce jointe et le `state` OAuth portent la charge que les
 * routes relisent, et le retour OAuth vise l'origine de l'app), et les
 * réglages de l'espace.
 *
 * `OAUTH_GOOGLE_*` est posé AVANT le chargement des handlers, parce que
 * `env.ts` lit l'environnement à l'import ; c'est la seule raison de l'import
 * dynamique ci-dessous.
 */

process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client';
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret';
delete process.env.OAUTH_MICROSOFT_CLIENT_ID;
const { mailHandlers } = await import('./handlers');

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

/**
 * Un dépôt en mémoire, même contrat que le vrai : ce que ces tests traversent
 * (comptes, réglages, la chaîne message → dossier → compte) est implémenté,
 * le reste lève s'il est atteint.
 */
function fakeRepo(): FakeRepo {
    let seq = 0;
    const accountRows: MailAccountRow[] = [];
    const folderRows: MailFolderRow[] = [];
    const messageRows: MailMessageRow[] = [];
    let settings: MailSettingsRow | null = null;
    return {
        accountRows,
        folderRows,
        messageRows,
        accounts: {
            listByWorkspace: async (ws) => accountRows.filter((a) => a.workspace_id === ws),
            findById: async (id, ws) => accountRows.find((a) => a.id === id && a.workspace_id === ws) ?? null,
            findByIdUnscoped: async (id) => accountRows.find((a) => a.id === id) ?? null,
            async create({ userId, workspaceId, ...c }) {
                const row: MailAccountRow = {
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
                    last_sync_at: null,
                    last_sync_error_enc: null,
                    last_sync_status: 'ok',
                    last_error_at: null,
                    credentials_enc: c.credentialsEnc,
                    created: 1
                };
                accountRows.push(row);
                return row;
            },
            update: unused,
            setEnabled: unused,
            delete: unused,
            reorder: unused,
            count: async (ws) => accountRows.filter((a) => a.workspace_id === ws).length,
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
            listByFolder: unused,
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
 * Un codec qui étiquette son étage : le harnais chiffre à l'identité, ce qui
 * ne dit pas SOUS QUEL codec une ligne a été écrite. Posé sur `ctx.cipher`, il
 * rend visible le choix du palier, qui est toute la question ici.
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
        const { authUrl } = await handlerFor(mailOAuthStart)(ctx, { provider: 'google', securityTier: 'open' });
        const url = new URL(authUrl);
        assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
        assert.equal(url.searchParams.get('client_id'), 'google-client');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://app.test/api/mail/oauth/callback');
        assert.deepEqual(ticketPayload(url.searchParams.get('state') ?? ''), {
            provider: 'google',
            securityTier: 'open'
        });
    });

    it('refuse un fournisseur non configuré, et un compte gardé dans un espace partagé', async () => {
        const ctx = createTestContext({ repo: fakeRepo(), kind: 'shared' });
        await assert.rejects(
            handlerFor(mailOAuthStart)(ctx, { provider: 'microsoft', securityTier: 'open' }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(mailOAuthStart)(ctx, { provider: 'google', securityTier: 'guarded' }),
            failsWith('validation')
        );
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

import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { BlobStore } from './engine/blobs';
import type { MailserverRepo } from './repo';

const PAGE = 200;

const BY_MAILBOX = 'mailbox_id IN (SELECT id FROM ft_mailserver_mailboxes WHERE workspace_id = ?)';

/** Trié comme la boîte : la date de réception, puis l'id qui départage. */
function emlName(internalDate: number, id: number): string {
    const stamp = new Date(internalDate * 1000).toISOString().slice(0, 19).replace(/:/g, '-');
    return `${stamp}-${id}.eml`;
}

/**
 * Les adresses sans mot de passe ni clé, leurs dossiers, leurs messages, leur
 * journal, et chaque corps en `.eml` sous `Boîtes/<adresse>/<dossier>/`, ouvert
 * par la clé de sa boîte.
 */
export function createAccountExport(blobs: BlobStore): FeatureAccountExport<MailserverRepo> {
    return {
        tables: {
            ft_mailserver_mailboxes: {
                file: 'adresses.json',
                where: 'workspace_id = ?',
                key: ['id'],
                sealed: ['content'],
                json: ['content'],
                dates: { password_set_at: 's', last_delivery_at: 's', last_login_at: 's', created: 's' },
                omit: ['password_hash', 'blob_key'],
                keep: ['password_set_at']
            },
            ft_mailserver_folders: { file: 'dossiers.json', where: BY_MAILBOX, key: ['id'] },
            ft_mailserver_messages: {
                file: 'messages.json',
                where: BY_MAILBOX,
                key: ['id'],
                sealed: ['meta'],
                json: ['meta'],
                dates: { internal_date: 's' }
            },
            ft_mailserver_events: {
                file: 'journal.json',
                where: BY_MAILBOX,
                key: ['id'],
                sealed: ['content'],
                json: ['content'],
                dates: { ts: 's' }
            },
            ft_mailserver_daily: { file: 'compteurs.json', where: BY_MAILBOX, key: ['mailbox_id', 'day'] },
            ft_mailserver_credentials: {
                file: 'mots-de-passe-d-application.json',
                where: BY_MAILBOX,
                key: ['id'],
                dates: { created: 's', last_used_at: 's' },
                omit: ['secret_hash']
            },
            ft_mailserver_domain_keys: {
                skip: 'Les clés DKIM des domaines signent le courrier en votre nom : elles ne sortent jamais.'
            },
            ft_mailserver_tls: { skip: 'Le certificat du serveur mail appartient au serveur, pas au compte.' },
            ft_mailserver_queue: { skip: 'Les envois en cours de remise sont un état passager du serveur.' },
            ft_mailserver_blobs: { skip: 'Les corps des messages sont dans le dossier Boîtes, en fichiers .eml.' }
        },
        files: {
            bodies: {
                label: 'le courrier hébergé',
                bytes: ({ repo, workspaceIds }) => repo.usedBytesInWorkspaces(workspaceIds)
            }
        },
        async workspace(ctx) {
            if (!ctx.includes('bodies')) return;
            let unreadable = 0;
            for (const item of await ctx.repo.listInWorkspaces([ctx.workspace.id])) {
                const mailbox = await ctx.repo.findById(Number(item.id));
                if (!mailbox) continue;
                const opened = ctx.keys.openBytes(mailbox.blob_key);
                if (opened === null) {
                    unreadable += Number(mailbox.message_count);
                    continue;
                }
                const key = Buffer.from(opened);
                const folders = new Map((await ctx.repo.listFolders(mailbox.id)).map((f) => [f.id, f.path]));
                for (let after = 0; ;) {
                    const page = await ctx.repo.exportPage(mailbox.id, after, PAGE);
                    for (const message of page) {
                        if (ctx.signal.aborted) return;
                        let raw: Buffer;
                        try {
                            raw = await blobs.read(mailbox.id, key, message.ref);
                        } catch {
                            unreadable++;
                            continue;
                        }
                        const folder = folders.get(message.folder_id) ?? 'INBOX';
                        await ctx.out.file(
                            `Boîtes/${mailbox.address}/${folder}/${emlName(message.internal_date, message.id)}`,
                            raw,
                            { mtime: message.internal_date }
                        );
                    }
                    if (page.length < PAGE) break;
                    after = page[page.length - 1].id;
                }
            }
            if (unreadable > 0) throw new Error(`${unreadable} message(s) illisible(s) ou introuvable(s)`);
        }
    };
}

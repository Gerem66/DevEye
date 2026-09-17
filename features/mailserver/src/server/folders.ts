import type { MailserverRepo } from './repo';

/** Les dossiers qu'une boîte neuve reçoit, avec l'usage que les clients y reconnaissent (RFC 6154). */
export const INITIAL_FOLDERS: readonly { path: string; specialUse: string | null }[] = [
    { path: 'INBOX', specialUse: null },
    { path: 'Drafts', specialUse: '\\Drafts' },
    { path: 'Sent', specialUse: '\\Sent' },
    { path: 'Junk', specialUse: '\\Junk' },
    { path: 'Trash', specialUse: '\\Trash' },
    { path: 'Archive', specialUse: '\\Archive' }
];

export async function createInitialFolders(repo: MailserverRepo, mailboxId: number): Promise<void> {
    for (const folder of INITIAL_FOLDERS) {
        await repo.createFolder({
            mailboxId,
            path: folder.path,
            specialUse: folder.specialUse,
            uidValidity: await repo.nextUidValidity(mailboxId)
        });
    }
}

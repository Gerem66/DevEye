import type { MessageRow } from '../repo';

/**
 * Ce qui arrive à un dossier, dit aux sessions IMAP qui l'ont ouvert : un
 * message remis, un autre supprimé ailleurs, des drapeaux changés par un autre
 * client. En mémoire, et valable parce que l'app est un seul processus.
 */
export type FolderEvent =
    | { type: 'exists'; message: MessageRow }
    | { type: 'expunge'; uid: number }
    | { type: 'flags'; uid: number; flags: number; keywords: string };

type FolderListener = (event: FolderEvent) => void;
type MailboxListener = () => void;

export class Notifier {
    private readonly folders = new Map<number, Set<FolderListener>>();
    private readonly mailboxes = new Map<number, Set<MailboxListener>>();

    watchFolder(folderId: number, listener: FolderListener): () => void {
        let set = this.folders.get(folderId);
        if (!set) {
            set = new Set();
            this.folders.set(folderId, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0) this.folders.delete(folderId);
        };
    }

    /** `except` : la session à l'origine du changement, qui l'annonce elle-même dans sa réponse. */
    emit(folderId: number, event: FolderEvent, except?: FolderListener): void {
        for (const listener of this.folders.get(folderId) ?? []) {
            if (listener !== except) listener(event);
        }
    }

    /** Prévenu quand la boîte est éteinte, supprimée, ou que ses identifiants changent. */
    watchMailbox(mailboxId: number, listener: MailboxListener): () => void {
        let set = this.mailboxes.get(mailboxId);
        if (!set) {
            set = new Set();
            this.mailboxes.set(mailboxId, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0) this.mailboxes.delete(mailboxId);
        };
    }

    dropMailbox(mailboxId: number): void {
        for (const listener of [...(this.mailboxes.get(mailboxId) ?? [])]) listener();
    }
}

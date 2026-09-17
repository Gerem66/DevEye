import { FLAG } from '../engine/mailstore';
import type { FolderEvent } from '../engine/notifier';
import type { FolderRow, MessageRow } from '../repo';
import { inSequenceSet, type SequenceRange } from './sequence';
import { atom, untagged, type ImapValue } from './wire';

/**
 * Le dossier tel que LA session le voit. Les numéros de séquence d'IMAP sont
 * des positions dans cette vue, et ne bougent que quand la session l'a dit au
 * client : ce que d'autres font au dossier attend dans `pending` jusqu'au
 * prochain moment où la RFC permet de l'annoncer.
 */

const SYSTEM_FLAGS: readonly [number, string][] = [
    [FLAG.Answered, '\\Answered'],
    [FLAG.Flagged, '\\Flagged'],
    [FLAG.Deleted, '\\Deleted'],
    [FLAG.Seen, '\\Seen'],
    [FLAG.Draft, '\\Draft']
];

export function flagList(flags: number, keywords: string): ImapValue[] {
    const out: ImapValue[] = SYSTEM_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => atom(name));
    for (const keyword of keywords.split(' ')) if (keyword !== '') out.push(atom(keyword));
    return out;
}

/** Des noms de drapeaux vers le masque et les mots-clés. `\Recent` appartient au serveur : ignoré. */
export function parseFlags(names: readonly string[]): { flags: number; keywords: string[] } | null {
    let flags = 0;
    const keywords: string[] = [];
    for (const name of names) {
        if (name.startsWith('\\')) {
            const known = SYSTEM_FLAGS.find(([, system]) => system.toLowerCase() === name.toLowerCase());
            if (known) flags |= known[0];
            else if (name.toLowerCase() !== '\\recent') return null;
        } else if (/^[^\s(){%*"\\\]]{1,64}$/.test(name)) {
            if (!keywords.includes(name)) keywords.push(name);
        } else {
            return null;
        }
    }
    return { flags, keywords };
}

export interface Located {
    seq: number;
    message: MessageRow;
}

export class MailboxView {
    messages: MessageRow[];
    private pending: FolderEvent[] = [];

    constructor(
        public folder: FolderRow,
        public readonly readOnly: boolean,
        messages: MessageRow[]
    ) {
        this.messages = messages;
    }

    queue(event: FolderEvent): void {
        this.pending.push(event);
    }

    hasPending(): boolean {
        return this.pending.length > 0;
    }

    /** Applique ce qui attendait et rend les lignes à écrire, dans l'ordre où c'est arrivé. */
    flush(): Buffer[] {
        const out: Buffer[] = [];
        let grew = false;
        for (const event of this.pending) {
            if (event.type === 'exists') {
                if (!this.messages.some((m) => m.uid === event.message.uid)) {
                    this.messages.push(event.message);
                    grew = true;
                }
            } else if (event.type === 'expunge') {
                const out1 = this.remove(event.uid);
                if (out1) out.push(out1);
            } else {
                const index = this.messages.findIndex((m) => m.uid === event.uid);
                if (index === -1) continue;
                const message = this.messages[index];
                message.flags = event.flags;
                message.keywords = event.keywords;
                out.push(
                    untagged(index + 1, atom('FETCH'), [
                        atom('FLAGS'),
                        flagList(message.flags, message.keywords),
                        atom('UID'),
                        message.uid
                    ])
                );
            }
        }
        this.pending = [];
        // Un seul EXISTS, après les EXPUNGE : il dit le compte final.
        if (grew) out.push(untagged(this.messages.length, atom('EXISTS')));
        return out;
    }

    /** Retire un message de la vue et rend son `* n EXPUNGE`, ou `null` s'il n'y était pas. */
    remove(uid: number): Buffer | null {
        const index = this.messages.findIndex((m) => m.uid === uid);
        if (index === -1) return null;
        this.messages.splice(index, 1);
        return untagged(index + 1, atom('EXPUNGE'));
    }

    maxUid(): number {
        return this.messages.length === 0 ? 0 : this.messages[this.messages.length - 1].uid;
    }

    /** Les messages qu'un ensemble désigne, par numéro de séquence ou par UID, dans l'ordre de la vue. */
    resolve(set: readonly SequenceRange[], byUid: boolean): Located[] {
        const out: Located[] = [];
        const max = byUid ? this.maxUid() : this.messages.length;
        // Une vue vide n'a pas de `*` : rien ne lui appartient.
        if (max === 0) return out;
        this.messages.forEach((message, index) => {
            if (inSequenceSet(set, byUid ? message.uid : index + 1, max)) out.push({ seq: index + 1, message });
        });
        return out;
    }

    firstUnseen(): number | null {
        const index = this.messages.findIndex((m) => (m.flags & FLAG.Seen) === 0);
        return index === -1 ? null : index + 1;
    }
}

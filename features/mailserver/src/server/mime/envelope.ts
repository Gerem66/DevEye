import addressparser from 'nodemailer/lib/addressparser';

import type { ImapValue } from '../imap/wire';
import { headerOf, type MimeHeader } from './tree';

/**
 * L'ENVELOPE d'IMAP (RFC 3501 §7.4.2). Les valeurs restent celles de l'en-tête,
 * mots encodés compris : c'est au client de les décoder, et il le fait.
 */

type Parsed = { name?: string; address?: string; group?: Parsed[] };

function one(entry: Parsed): ImapValue[] {
    const address = entry.address ?? '';
    const at = address.lastIndexOf('@');
    return [
        entry.name ? entry.name : null,
        null,
        at === -1 ? address || null : address.slice(0, at),
        at === -1 ? null : address.slice(at + 1)
    ];
}

function addressList(raw: string | null): ImapValue {
    if (raw === null || raw.trim() === '') return null;
    const out: ImapValue[] = [];
    for (const entry of addressparser(raw) as Parsed[]) {
        if (entry.group) {
            // Un groupe s'ouvre et se ferme par deux adresses sans hôte.
            out.push([null, null, entry.name ?? '', null]);
            for (const member of entry.group) out.push(one(member));
            out.push([null, null, null, null]);
        } else if (entry.address || entry.name) {
            out.push(one(entry));
        }
    }
    // La grammaire colle les adresses : `((...)(...))`, sans espace entre elles.
    return out.length > 0 ? [{ glued: out }] : null;
}

export function buildEnvelope(headers: readonly MimeHeader[]): ImapValue[] {
    const from = addressList(headerOf(headers, 'from'));
    return [
        headerOf(headers, 'date'),
        headerOf(headers, 'subject'),
        from,
        // Absents, `Sender` et `Reply-To` valent `From` : la RFC l'impose au serveur.
        addressList(headerOf(headers, 'sender')) ?? from,
        addressList(headerOf(headers, 'reply-to')) ?? from,
        addressList(headerOf(headers, 'to')),
        addressList(headerOf(headers, 'cc')),
        addressList(headerOf(headers, 'bcc')),
        headerOf(headers, 'in-reply-to'),
        headerOf(headers, 'message-id')
    ];
}

import type { ImapValue } from '../imap/wire';
import { buildEnvelope } from './envelope';
import type { ContentField, MimeNode } from './tree';

/** `BODYSTRUCTURE` (RFC 3501 §7.4.2), ou `BODY` quand `extended` est faux : sans les champs d'extension. */

function paramList(params: Record<string, string>): ImapValue {
    const entries = Object.entries(params);
    return entries.length === 0 ? null : entries.flatMap(([key, value]) => [key, value]);
}

const dispositionOf = (field: ContentField | null): ImapValue =>
    field === null ? null : [field.value, paramList(field.params)];

const languageOf = (tags: string[] | null): ImapValue =>
    tags === null || tags.length === 0 ? null : tags.length === 1 ? tags[0] : tags;

export function buildBodyStructure(node: MimeNode, extended: boolean): ImapValue[] {
    if (node.type === 'multipart' && node.children.length > 0) {
        // Les parties se suivent SANS espace : `(...)(...) "mixed"`.
        const parts: ImapValue = { glued: node.children.map((child) => buildBodyStructure(child, extended)) };
        const tail: ImapValue[] = [node.subtype];
        if (extended) {
            tail.push(
                paramList(node.params),
                dispositionOf(node.disposition),
                languageOf(node.language),
                node.location
            );
        }
        return [parts, ...tail];
    }

    const out: ImapValue[] = [
        node.type,
        node.subtype,
        paramList(node.params),
        node.id,
        node.description,
        node.encoding,
        node.end - node.bodyStart
    ];
    if (node.type === 'message' && node.subtype === 'rfc822' && node.message) {
        out.push(buildEnvelope(node.message.headers ?? []), buildBodyStructure(node.message, extended), node.lines);
    } else if (node.type === 'text') {
        out.push(node.lines);
    }
    if (extended) out.push(node.md5, dispositionOf(node.disposition), languageOf(node.language), node.location);
    return out;
}

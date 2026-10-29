import { simpleParser } from 'mailparser';
import type { MailAttachment, MailHeader, MailSuspiciousLink } from '../contracts/domain';
import { sanitizeMailHtml, type SanitizeOptions } from './sanitize';
import { findSuspiciousLinks } from './linkHeuristics';

export interface ParsedMailBody {
    /** Every header line as received, in order. */
    headers: MailHeader[];
    bodyHtml: string | null;
    bodyText: string | null;
    attachments: MailAttachment[];
    remoteImagesBlocked: boolean;
    blockedImageSources: string[];
    suspiciousLinks: MailSuspiciousLink[];
}

/**
 * Header lines exactly as received, unfolded onto one line each. No
 * deduplication and no reordering: a `Received:` chain only means anything in
 * the order it arrived, and repeated headers are themselves evidence.
 */
function toHeaders(lines: ReadonlyArray<{ line: string }>): MailHeader[] {
    return lines.map(({ line }) => {
        const unfolded = line.replace(/\r?\n[ \t]+/g, ' ');
        const separator = unfolded.indexOf(':');
        if (separator === -1) return { name: unfolded.trim(), value: '' };
        return { name: unfolded.slice(0, separator).trim(), value: unfolded.slice(separator + 1).trim() };
    });
}

/**
 * Stable handle for one attachment. Positional as a fallback, so it must be
 * derived from the same list in the same order on both sides — listing and
 * downloading.
 */
function attachmentId(attachment: { cid?: string }, index: number): string {
    return attachment.cid ?? `att-${index}`;
}

/**
 * Un message analysé, avant tout assainissement : ce que le cache des corps
 * garde (chiffré), parce que l'assainissement dépend des réglages du lecteur et
 * se refait à chaque lecture. Les octets des pièces jointes n'y sont pas.
 */
export interface ParsedMail {
    headers: MailHeader[];
    html: string | null;
    text: string | null;
    attachments: MailAttachment[];
}

/** Parse raw RFC822 bytes: headers, bodies and the attachment list. */
export async function parseMail(raw: Buffer): Promise<ParsedMail> {
    const parsed = await simpleParser(raw, { skipHtmlToText: true });
    const attachments: MailAttachment[] = parsed.attachments
        // Index over the *unparsed* list, the way `findAttachmentBytes` re-derives
        // ids: filtering first would renumber everything after an inline image and
        // hand back the wrong file.
        .map((a, i) => ({ attachment: a, id: attachmentId(a, i) }))
        // Inline images already referenced by the HTML body aren't useful as a
        // separate "attachments" list.
        .filter(({ attachment }) => !attachment.related)
        .map(({ attachment, id }) => ({
            id,
            filename: attachment.filename ?? 'fichier',
            mimeType: attachment.contentType,
            size: attachment.size
        }));
    return {
        headers: toHeaders(parsed.headerLines),
        html: typeof parsed.html === 'string' ? parsed.html : null,
        text: parsed.text ?? null,
        attachments
    };
}

/** Run the security pipeline on a parsed message's HTML body. */
export function sanitizeParsed(parsed: ParsedMail, sanitizeOpts: SanitizeOptions): ParsedMailBody {
    let bodyHtml: string | null = null;
    let remoteImagesBlocked = false;
    let blockedImageSources: string[] = [];
    let suspiciousLinks: MailSuspiciousLink[] = [];
    if (parsed.html !== null) {
        const sanitized = sanitizeMailHtml(parsed.html, sanitizeOpts);
        bodyHtml = sanitized.html;
        remoteImagesBlocked = sanitized.remoteImagesBlocked;
        blockedImageSources = sanitized.blockedSources;
        suspiciousLinks = findSuspiciousLinks(sanitized.html);
    }
    return {
        headers: parsed.headers,
        bodyHtml,
        bodyText: parsed.text,
        attachments: parsed.attachments,
        remoteImagesBlocked,
        blockedImageSources,
        suspiciousLinks
    };
}

/** Raw bytes of one attachment, re-derived from the parsed message (never cached). */
export async function findAttachmentBytes(
    raw: Buffer,
    wanted: string
): Promise<{ filename: string; mimeType: string; content: Buffer } | null> {
    const parsed = await simpleParser(raw, { skipHtmlToText: true });
    const match = parsed.attachments.find((a, i) => attachmentId(a, i) === wanted);
    if (!match) return null;
    return { filename: match.filename ?? 'fichier', mimeType: match.contentType, content: match.content };
}

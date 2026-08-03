import { simpleParser } from 'mailparser';
import type { MailAttachment, MailHeader, MailSuspiciousLink } from 'deveye-types';
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

/** Parse raw RFC822 bytes and run the security pipeline on the HTML body. */
export async function parseAndSanitize(raw: Buffer, sanitizeOpts: SanitizeOptions): Promise<ParsedMailBody> {
    const parsed = await simpleParser(raw, { skipHtmlToText: true });

    let bodyHtml: string | null = null;
    let remoteImagesBlocked = false;
    let blockedImageSources: string[] = [];
    let suspiciousLinks: MailSuspiciousLink[] = [];
    if (typeof parsed.html === 'string') {
        const sanitized = sanitizeMailHtml(parsed.html, sanitizeOpts);
        bodyHtml = sanitized.html;
        remoteImagesBlocked = sanitized.remoteImagesBlocked;
        blockedImageSources = sanitized.blockedSources;
        suspiciousLinks = findSuspiciousLinks(sanitized.html);
    }

    const attachments: MailAttachment[] = parsed.attachments
        // Index over the *unparsed* list, so an id is a stable handle into the
        // message as parsed — `findAttachmentBytes` re-derives ids the same way.
        // Filtering first would renumber everything after an inline image and
        // hand back the wrong file (see `attachmentId`).
        .map((a, i) => ({ attachment: a, id: attachmentId(a, i) }))
        // Inline images already referenced by the (now-blocked) HTML body aren't
        // useful as a separate "attachments" list in V1.
        .filter(({ attachment }) => !attachment.related)
        .map(({ attachment, id }) => ({
            id,
            filename: attachment.filename ?? 'fichier',
            mimeType: attachment.contentType,
            size: attachment.size
        }));

    return {
        headers: toHeaders(parsed.headerLines),
        bodyHtml,
        bodyText: parsed.text ?? null,
        attachments,
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

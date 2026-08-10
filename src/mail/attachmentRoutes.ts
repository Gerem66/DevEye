import type { FastifyInstance } from 'fastify';
import { verifyMailAttachmentToken } from '@/auth/jwt';
import * as mailClient from '@/Services/MailAccountClient';
import { cipherForTier, decryptCredentials, persistRefreshedToken } from '@/features/mail/_shared';
import { findAttachmentBytes } from './parseMessage';
import type Encryption from '@/Services/Encryption';

import type { Database } from '@/db';

interface MailAttachmentRouteDeps {
    db: Database;
    crypt: Encryption;
}

/**
 * Streams one attachment's bytes, re-derived live from IMAP (never cached
 * server-side, matching the rest of Mail's storage policy). Reached via the
 * short-lived signed URL `mail.attachmentDownload` hands back — a plain GET
 * so the browser's native download flow (Content-Disposition) just works,
 * rather than piping bytes back over the WebSocket.
 */
/**
 * `Content-Disposition` for a filename that came out of an untrusted email.
 * The plain `filename=` form is reduced to safe ASCII — anything else (a
 * newline especially, which Node rejects outright and would turn a download
 * into a 500) is dropped — and the real name is carried by the RFC 5987
 * `filename*` form, which browsers prefer when both are present.
 */
function contentDisposition(filename: string): string {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    const fallback = ascii.trim() || 'fichier';
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function mailAttachmentRoutes(
    app: FastifyInstance,
    { db, crypt }: MailAttachmentRouteDeps
): Promise<void> {
    app.get<{ Querystring: { token?: string } }>('/api/mail/attachment', async (req, reply) => {
        const token = req.query.token;
        if (!token) return reply.code(400).send({ error: 'missing_token' });
        const claims = await verifyMailAttachmentToken(token);
        if (!claims) return reply.code(401).send({ error: 'invalid_token' });

        const message = await db.mailMessages.findById(claims.messageId);
        if (!message) return reply.code(404).send({ error: 'not_found' });
        const folder = await db.mailFolders.findById(message.folder_id);
        if (!folder) return reply.code(404).send({ error: 'not_found' });
        const account = await db.mailAccounts.findById(folder.account_id, claims.workspaceId);
        if (!account) return reply.code(404).send({ error: 'not_found' });

        const cipher = await cipherForTier(
            db,
            crypt,
            claims.workspaceId,
            claims.userId,
            claims.sessionId,
            account.security_tier
        );

        try {
            const credentials = await decryptCredentials(cipher, account.credentials_enc);
            const refresh = persistRefreshedToken(db, account.id, credentials, cipher);
            const raw = await mailClient.fetchMessageRaw(credentials, folder.imap_path, message.uid, refresh);
            const attachment = await findAttachmentBytes(raw, claims.attachmentId);
            if (!attachment) return reply.code(404).send({ error: 'not_found' });

            reply.header('Content-Type', attachment.mimeType || 'application/octet-stream');
            reply.header('Content-Length', attachment.content.length);
            reply.header('Content-Disposition', contentDisposition(attachment.filename));
            return reply.send(attachment.content);
        } catch (e) {
            req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'Mail attachment download failed');
            return reply.code(502).send({ error: 'fetch_failed' });
        }
    });
}

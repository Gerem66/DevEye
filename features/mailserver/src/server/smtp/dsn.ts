import crypto from 'node:crypto';

/**
 * L'avis de non-remise (RFC 3464) rendu à l'expéditeur : un texte lisible, un
 * état lisible par une machine, et les en-têtes du message d'origine.
 */
export function buildBounce(input: {
    hostname: string;
    sender: string;
    recipient: string;
    /** `5.x.x` définitif, ou le dernier état d'une série d'essais épuisée. */
    diagnostic: string;
    originalHeaders: string;
}): Buffer {
    const boundary = `dsn-${crypto.randomBytes(12).toString('hex')}`;
    const date = new Date().toUTCString().replace('GMT', '+0000');
    const status = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(input.diagnostic)?.[1] ?? '5.0.0';
    const lines = [
        `From: Mail Delivery System <MAILER-DAEMON@${input.hostname}>`,
        `To: <${input.sender}>`,
        'Subject: Undelivered Mail Returned to Sender',
        `Date: ${date}`,
        `Message-ID: <${crypto.randomUUID()}@${input.hostname}>`,
        'Auto-Submitted: auto-replied',
        'MIME-Version: 1.0',
        `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        `Votre message n’a pas pu être remis à ${input.recipient}.`,
        '',
        `Le serveur du destinataire a répondu : ${input.diagnostic}`,
        '',
        'Aucune nouvelle tentative ne sera faite.',
        '',
        `--${boundary}`,
        'Content-Type: message/delivery-status',
        '',
        `Reporting-MTA: dns; ${input.hostname}`,
        '',
        `Final-Recipient: rfc822; ${input.recipient}`,
        'Action: failed',
        `Status: ${status}`,
        `Diagnostic-Code: smtp; ${input.diagnostic.replace(/\s+/g, ' ')}`,
        '',
        `--${boundary}`,
        'Content-Type: text/rfc822-headers',
        '',
        input.originalHeaders.trimEnd(),
        '',
        `--${boundary}--`,
        ''
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8');
}

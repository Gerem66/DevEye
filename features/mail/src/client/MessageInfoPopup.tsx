import { useState } from 'react';

import { Button, ClosePopup, DialogCancelButton, formatBytesFr, Popup } from 'deveye-sdk-client';

import { formatAddress } from './api';
import styles from './style.module.css';

import type { MailMessage } from '../contracts/domain';

export const MESSAGE_INFO_POPUP = 'popup-mail-message-info';

function formatDate(epochSeconds: number): string {
    const date = new Date(epochSeconds * 1000);
    return `${date.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' })} — ${date.toISOString()}`;
}

/** Header lines back in wire form, for pasting into a ticket or an analyser. */
function headersAsText(message: MailMessage): string {
    return message.headers.map((h) => `${h.name}: ${h.value}`).join('\n');
}

function activeFlags(message: MailMessage): string {
    const set = Object.entries(message.flags)
        .filter(([, on]) => on)
        .map(([name]) => `\\${name[0].toUpperCase()}${name.slice(1)}`);
    return set.length > 0 ? set.join(' ') : '—';
}

interface RowProps {
    label: string;
    children: React.ReactNode;
}

function Row({ label, children }: RowProps) {
    return (
        <div className={styles.infoRow}>
            <span className={styles.infoLabel}>{label}</span>
            <span className={styles.infoValue}>{children}</span>
        </div>
    );
}

/**
 * Everything the protocol actually told us about one message, unabridged: the
 * IMAP coordinates that identify it server-side, and every header line in receipt
 * order. Deliberately not curated, the point being tracing a message after the
 * fact (delivery path, authentication verdicts, list plumbing). Nothing here is
 * fetched separately: it rides along with the body, read live from IMAP.
 */
export function MessageInfoPopup() {
    const [message, setMessage] = useState<MailMessage | null>(null);
    const [copied, setCopied] = useState(false);

    function handleOpen(input: MailMessage | null): void {
        if (!input) return;
        setMessage(input);
        setCopied(false);
    }

    async function copyHeaders(): Promise<void> {
        if (!message) return;
        try {
            await navigator.clipboard.writeText(headersAsText(message));
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }

    return (
        <Popup<MailMessage | null>
            id={MESSAGE_INFO_POPUP}
            title='Informations techniques'
            width={840}
            tall
            onInputChange={handleOpen}
            onClosePopup={() => ClosePopup(MESSAGE_INFO_POPUP, true)}
        >
            {!message ? (
                <p className={styles.status}>Aucun message.</p>
            ) : (
                <div className={styles.infoBody}>
                    <p className={styles.sectionLabel}>Message</p>
                    <Row label='Objet'>{message.subject || '(sans objet)'}</Row>
                    <Row label='De'>{message.from ? formatAddress(message.from) : '(inconnu)'}</Row>
                    <Row label='À'>{message.to.map(formatAddress).join(', ') || '—'}</Row>
                    <Row label='Date'>{formatDate(message.date)}</Row>
                    <Row label='Taille brute'>
                        {formatBytesFr(message.sizeBytes)} ({message.sizeBytes} octets)
                    </Row>

                    <p className={styles.sectionLabel}>Emplacement</p>
                    <Row label='Dossier IMAP'>
                        <code>{message.folderPath}</code>
                    </Row>
                    <Row label='UID IMAP'>
                        <code>{message.uid}</code>
                    </Row>
                    <Row label='Identifiants DevEye'>
                        <code>
                            message #{message.id} · dossier #{message.folderId} · compte #{message.accountId}
                        </code>
                    </Row>
                    <Row label='Marqueurs'>
                        <code>{activeFlags(message)}</code>
                    </Row>
                    <Row label='Pièces jointes'>
                        {message.attachments.length === 0
                            ? 'aucune'
                            : message.attachments
                                  .map((a) => `${a.filename} (${a.mimeType}, ${formatBytesFr(a.size)})`)
                                  .join(' · ')}
                    </Row>

                    <p className={styles.sectionLabel}>Contrôles de sécurité</p>
                    <Row label='Images distantes'>
                        {message.remoteImagesBlocked
                            ? `bloquées — ${message.blockedImageSources.join(', ') || 'source inconnue'}`
                            : 'aucune bloquée'}
                    </Row>
                    <Row label='Liens signalés'>
                        {message.suspiciousLinks.length === 0
                            ? 'aucun'
                            : message.suspiciousLinks.map((l) => `${l.href} (${l.reason})`).join(' · ')}
                    </Row>

                    <div className={styles.infoHeadersHead}>
                        <p className={styles.sectionLabel}>En-têtes bruts ({message.headers.length})</p>
                        <Button variant='secondary' icon='copy' onClick={() => void copyHeaders()}>
                            {copied ? 'Copié' : 'Copier'}
                        </Button>
                    </div>
                    <div className={styles.infoHeaders}>
                        {message.headers.map((header, i) => (
                            <div key={`${header.name}-${i}`} className={styles.infoHeaderRow}>
                                <span className={styles.infoHeaderName}>{header.name}</span>
                                <span className={styles.infoHeaderValue}>{header.value}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                </div>
            </div>
        </Popup>
    );
}

export default MessageInfoPopup;

import { useRef, useState } from 'react';

import { Button, formatBytesFr } from 'deveye-sdk-client';

import ImageSourcesPopup from './ImageSourcesPopup';
import { formatAddress } from './api';
import styles from './style.module.css';

import type { MailBodyRenderMode, MailMessage } from '../contracts/domain';

interface MessagePaneProps {
    message: MailMessage | null;
    loading: boolean;
    renderMode: MailBodyRenderMode;
    onLoadImages: () => void;
    onTrustImageSources: (domains: string[]) => void;
    onToggleSeen: () => void;
    onToggleFlagged: () => void;
    onDelete: () => void;
    onDownloadAttachment: (attachmentId: string) => void;
    onShowInfo: () => void;
}

const LINK_WARNING_LABEL: Record<string, string> = {
    'text-href-mismatch': 'Le lien affiché ne correspond pas à sa destination réelle',
    'lookalike-domain': 'Ce domaine ressemble à une marque connue — vérifiez-le avant de cliquer',
    'unsafe-scheme': 'Lien potentiellement dangereux neutralisé'
};

function formatFullDate(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/** Minimal standalone document the "raw" mode iframe renders — white background, the message's own styling untouched. */
function rawDocument(bodyHtml: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="background:#fff;color:#111;margin:0;padding:16px;font-family:sans-serif;">${bodyHtml}</body></html>`;
}

/**
 * Reading pane. `message.bodyHtml` is already sanitized server-side (see
 * `src/mail/sanitize.ts`) — no `<script>`, no event handlers — so rendering
 * it directly is safe; blocked remote images show as a banner instead of
 * silently loading. In `raw` render mode the body instead goes into a
 * `sandbox=""` iframe: fully script-disabled and opaque-origin, so the
 * message's own `<style>`/inline CSS (preserved by the server only in that
 * mode) can't reach or be reached by the rest of the app.
 */
/** Short collapsed-banner label — combines both alert kinds into one line. */
function alertSummary(message: MailMessage): string {
    const parts: string[] = [];
    if (message.remoteImagesBlocked) parts.push('images distantes bloquées');
    const linkCount = message.suspiciousLinks.length;
    if (linkCount > 0) parts.push(`${linkCount} lien${linkCount > 1 ? 's' : ''} suspect${linkCount > 1 ? 's' : ''}`);
    return parts.join(' · ');
}

export function MessagePane({
    message,
    loading,
    renderMode,
    onLoadImages,
    onTrustImageSources,
    onToggleSeen,
    onToggleFlagged,
    onDelete,
    onDownloadAttachment,
    onShowInfo
}: MessagePaneProps) {
    const [sourcesOpen, setSourcesOpen] = useState(false);
    const [alertsOpen, setAlertsOpen] = useState(false);
    const sourcesBtnRef = useRef<HTMLButtonElement>(null);

    // Only blank the pane for a first load (no `message` yet) — reloading an
    // already-open one (e.g. to unblock its images) keeps showing the current
    // content until the refreshed version actually lands, no flash to empty.
    if (loading && !message) return <p className={styles.empty}>Chargement du message…</p>;
    if (!message) return <p className={styles.empty}>Sélectionnez un message.</p>;

    const hasAlerts = message.remoteImagesBlocked || message.suspiciousLinks.length > 0;

    return (
        <div className={styles.messagePane}>
            <div className={styles.messagePaneActions}>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title={message.flags.seen ? 'Marquer non lu' : 'Marquer lu'}
                    onClick={onToggleSeen}
                >
                    <span className={`icon icon-${message.flags.seen ? 'eye-close' : 'eye-open'}`} />
                </button>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title={message.flags.flagged ? 'Retirer le marqueur' : 'Marquer'}
                    onClick={onToggleFlagged}
                >
                    <span className={`icon icon-${message.flags.flagged ? 'star' : 'star-outline'}`} />
                </button>
                <button type='button' className={styles.iconBtn} title='Supprimer' onClick={onDelete}>
                    <span className='icon icon-trash' />
                </button>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title='Informations techniques (en-têtes bruts, coordonnées IMAP…)'
                    aria-label='Informations techniques'
                    onClick={onShowInfo}
                >
                    <span className='icon icon-info' />
                </button>
            </div>
            <p className={styles.messagePaneMeta}>
                De : {message.from ? formatAddress(message.from) : 'inconnu'}
                <br />À : {message.to.map((a) => a.name || a.address).join(', ') || '—'}
                <br />
                {formatFullDate(message.date)}
            </p>

            {hasAlerts && (
                <div className={styles.alertBanner}>
                    <button
                        type='button'
                        className={styles.alertBannerHeader}
                        aria-expanded={alertsOpen}
                        onClick={() => setAlertsOpen((o) => !o)}
                    >
                        <span className='icon icon-shield' />
                        <span>{alertSummary(message)}</span>
                        <span
                            className={`icon icon-chevron-down ${styles.alertBannerChevron} ${
                                alertsOpen ? styles.alertBannerChevronOpen : ''
                            }`}
                        />
                    </button>
                    {alertsOpen && (
                        <div className={styles.alertBannerBody}>
                            {message.remoteImagesBlocked && (
                                <div className={styles.imageBanner}>
                                    <span>Images distantes bloquées pour protéger votre vie privée.</span>
                                    <div className={styles.imageBannerActions}>
                                        <Button variant='secondary' onClick={onLoadImages}>
                                            Charger les images
                                        </Button>
                                        <button
                                            ref={sourcesBtnRef}
                                            type='button'
                                            className={styles.iconBtn}
                                            title='Choisir les sources à autoriser'
                                            aria-label='Choisir les sources à autoriser'
                                            onClick={() => setSourcesOpen((o) => !o)}
                                        >
                                            <span className='icon icon-list' />
                                        </button>
                                        <ImageSourcesPopup
                                            anchorRef={sourcesBtnRef}
                                            open={sourcesOpen}
                                            onClose={() => setSourcesOpen(false)}
                                            sources={message.blockedImageSources}
                                            onLoadNow={onLoadImages}
                                            onTrustAlways={onTrustImageSources}
                                        />
                                    </div>
                                </div>
                            )}
                            {message.suspiciousLinks.length > 0 && (
                                <div className={styles.linkWarnings}>
                                    {message.suspiciousLinks.map((link, i) => (
                                        <p key={i} className={styles.linkWarning}>
                                            <span className='icon icon-shield' /> {LINK_WARNING_LABEL[link.reason]} —{' '}
                                            <code>{link.href}</code>
                                        </p>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {message.attachments.length > 0 && (
                <div className={styles.attachments}>
                    {message.attachments.map((att) => (
                        <button
                            key={att.id}
                            type='button'
                            className={styles.attachment}
                            onClick={() => onDownloadAttachment(att.id)}
                        >
                            <span className='icon icon-file' />
                            <span>{att.filename}</span>
                            <span className={styles.attachmentSize}>{formatBytesFr(att.size)}</span>
                        </button>
                    ))}
                </div>
            )}

            {message.bodyHtml ? (
                renderMode === 'raw' ? (
                    <iframe
                        className={styles.messageBodyFrame}
                        sandbox=''
                        title='Contenu du message'
                        srcDoc={rawDocument(message.bodyHtml)}
                    />
                ) : (
                    <div className={styles.messageBody} dangerouslySetInnerHTML={{ __html: message.bodyHtml }} />
                )
            ) : (
                <pre className={styles.messageBodyText}>{message.bodyText || '(message vide)'}</pre>
            )}
        </div>
    );
}

export default MessagePane;

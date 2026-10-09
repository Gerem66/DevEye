import { Dialog } from 'deveye-sdk-client';

import MessagePane from './MessagePane';
import styles from './style.module.css';

import type { MailMessage } from '../contracts/domain';

interface MessagePopupProps {
    open: boolean;
    message: MailMessage | null;
    loading: boolean;
    onClose: () => void;
    onLoadImages: () => void;
    onTrustImageSources: (domains: string[]) => void;
    onToggleSeen: () => void;
    onToggleFlagged: () => void;
    onDelete: () => void;
    onDownloadAttachment: (attachmentId: string) => void;
    onShowInfo: () => void;
}

/**
 * Reading surface for a single message, as a popup rather than a permanent third
 * column, which frees the message list to use the full width for browsing.
 *
 * Deliberately NOT `tall`: that mode pins the dialog to a fixed viewport-height
 * box, leaving a short message floating above a large dead area. Sized to its
 * content instead, with `Dialog`'s own `max-height` + scroll taking over once a
 * message is long enough to need it.
 */
export function MessagePopup({ open, message, loading, onClose, ...paneProps }: MessagePopupProps) {
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={message ? message.subject || '(sans objet)' : loading ? 'Chargement…' : ''}
            width={940}
        >
            <div className={styles.messagePopupBody}>
                <MessagePane message={message} loading={loading} {...paneProps} />
            </div>
        </Dialog>
    );
}

export default MessagePopup;

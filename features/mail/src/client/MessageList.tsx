import { memo, useEffect, useRef } from 'react';
import { useLiveOutlines, type LiveOutlineProps } from 'deveye-sdk-client';

import styles from './style.module.css';

import type { MailMessageSummary } from '../contracts/domain';

interface MessageListProps {
    messages: MailMessageSummary[];
    selectedId: number | null;
    onSelect: (message: MailMessageSummary) => void;
    onToggleSeen: (message: MailMessageSummary) => void;
    onToggleFlagged: (message: MailMessageSummary) => void;
    onDelete: (message: MailMessageSummary) => void;
    onLoadMore: () => void;
    hasMore: boolean;
    loading: boolean;
    /** Shown when the list settles on nothing. `null` leaves it blank, for when the caller says it better itself. */
    emptyLabel: string | null;
    /** The actual scrolling ancestor (`.messageColumn`), this list itself not scrolling. */
    scrollRootRef: React.RefObject<HTMLElement | null>;
}

function formatDate(epochSeconds: number): string {
    const date = new Date(epochSeconds * 1000);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
        ? date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

interface MessageRowProps {
    message: MailMessageSummary;
    selected: boolean;
    /** Quelqu'un lit ce message : sa couleur autour de la ligne. Mémorisé par
     *  `useLiveOutlines`, donc stable tant que personne ne bouge. */
    outline: LiveOutlineProps;
    onSelect: (message: MailMessageSummary) => void;
    onToggleSeen: (message: MailMessageSummary) => void;
    onToggleFlagged: (message: MailMessageSummary) => void;
    onDelete: (message: MailMessageSummary) => void;
}

/**
 * One row, memoized on its own props. Opening a message rewrites the `messages`
 * array (to flip its read state) and the host re-renders on every refresh;
 * without this, each of those repaints all ~50 rows and their icons at once. The
 * callbacks it receives are stable by contract.
 */
const MessageRow = memo(function MessageRow({
    message,
    selected,
    outline,
    onSelect,
    onToggleSeen,
    onToggleFlagged,
    onDelete
}: MessageRowProps) {
    const action = (run: (m: MailMessageSummary) => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        run(message);
    };

    return (
        <div
            role='button'
            tabIndex={0}
            className={`${styles.messageRow} ${selected ? styles.messageRowSelected : ''} ${
                message.flags.seen ? '' : styles.messageRowUnread
            }`}
            onClick={() => onSelect(message)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(message);
                }
            }}
            {...outline}
        >
            <div className={styles.messageRowMain}>
                <div className={styles.messageRowHead}>
                    <span className={styles.messageFrom}>
                        {message.from ? message.from.name || message.from.address : '(expéditeur inconnu)'}
                    </span>
                </div>
                <div className={styles.messageRowBody}>
                    <span className={styles.messageSubject}>{message.subject || '(sans objet)'}</span>
                    {message.hasAttachments && <span className='icon icon-folder' title='Pièce jointe' />}
                    {message.flags.flagged && <span className='icon icon-star' title='Marqué' />}
                </div>
            </div>
            {/* Sibling of the whole two-line block, not of the sender line: that's
                what lets it stretch to the row's real height, so the hover actions
                centre on the row instead of on its first line. */}
            <div className={styles.messageMeta}>
                <div className={styles.messageRowActions}>
                    <button
                        type='button'
                        className={styles.iconBtn}
                        title={message.flags.seen ? 'Marquer non lu' : 'Marquer lu'}
                        aria-label={message.flags.seen ? 'Marquer non lu' : 'Marquer lu'}
                        onClick={action(onToggleSeen)}
                    >
                        <span className={`icon icon-${message.flags.seen ? 'eye-close' : 'eye-open'}`} />
                    </button>
                    <button
                        type='button'
                        className={styles.iconBtn}
                        title={message.flags.flagged ? 'Retirer le marqueur' : 'Marquer'}
                        aria-label={message.flags.flagged ? 'Retirer le marqueur' : 'Marquer'}
                        onClick={action(onToggleFlagged)}
                    >
                        <span className={`icon icon-${message.flags.flagged ? 'star' : 'star-outline'}`} />
                    </button>
                    <button
                        type='button'
                        className={styles.iconBtn}
                        title='Supprimer'
                        aria-label='Supprimer'
                        onClick={action(onDelete)}
                    >
                        <span className='icon icon-trash' />
                    </button>
                </div>
                <span className={styles.messageDate}>{formatDate(message.date)}</span>
            </div>
        </div>
    );
});

function MessageListImpl({
    messages,
    selectedId,
    onSelect,
    onToggleSeen,
    onToggleFlagged,
    onDelete,
    onLoadMore,
    hasMore,
    loading,
    emptyLabel,
    scrollRootRef
}: MessageListProps) {
    const sentinelRef = useRef<HTMLDivElement>(null);
    // Quelqu'un lit l'un de ces messages : sa couleur sur la ligne. Un pair resté
    // sur la liste n'a pas ce niveau, et n'entoure donc rien.
    const outlineOf = useLiveOutlines('l3');

    // Auto-loads the next page as the sentinel (end of the list) nears the
    // viewport, instead of requiring a manual "load more" click. `onLoadMore`
    // has to stay stable across renders or this tears the observer down and
    // rebuilds it constantly, re-firing against whatever is already on screen.
    useEffect(() => {
        if (!hasMore || loading) return;
        const sentinel = sentinelRef.current;
        if (!sentinel) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) onLoadMore();
            },
            { root: scrollRootRef.current, rootMargin: '200px' }
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [hasMore, loading, onLoadMore, scrollRootRef]);

    if (!loading && messages.length === 0) {
        return emptyLabel === null ? null : <p className={styles.empty}>{emptyLabel}</p>;
    }

    return (
        <div className={styles.messageList}>
            {messages.map((message) => (
                <MessageRow
                    key={message.id}
                    message={message}
                    selected={selectedId === message.id}
                    outline={outlineOf(String(message.id))}
                    onSelect={onSelect}
                    onToggleSeen={onToggleSeen}
                    onToggleFlagged={onToggleFlagged}
                    onDelete={onDelete}
                />
            ))}
            {hasMore && (
                <div ref={sentinelRef} className={styles.messageListSentinel}>
                    {loading && 'Chargement…'}
                </div>
            )}
        </div>
    );
}

export const MessageList = memo(MessageListImpl);

export default MessageList;

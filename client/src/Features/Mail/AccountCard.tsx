import { StatusBadge } from '@/Components/StatusBadge';
import { describeAccountStatus } from './accountStatus';
import SyncProgressBar from './SyncProgressBar';
import styles from './style.module.css';

import type { MailAccount } from 'deveye-types';
import { useLiveOutline } from '@/live/useLiveOutline';

interface AccountCardProps {
    account: MailAccount;
    selected: boolean;
    busy: boolean;
    dragging: boolean;
    onOpen: () => void;
    onEdit: () => void;
    onToggle: () => void;
    onDragPointerDown: (e: React.PointerEvent) => void;
}

function formatAgo(epochSeconds: number | null): string {
    if (epochSeconds === null) return 'jamais synchronisé';
    const seconds = Math.floor(Date.now() / 1000) - epochSeconds;
    if (seconds < 60) return 'à l’instant';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

/**
 * One configured mail account, as a centered tile (not a list row) — deleting
 * an account lives one step further away, in the edit popup's own danger
 * button, since it's rare and shouldn't be a one-click affair from here. That
 * popup is also the only route to delete, which is why the edit button shows
 * for every account and not just password-auth ones: an OAuth mailbox opens it
 * read-only (see `AccountPopup`), but it does open.
 *
 * The drag grab surface is the small top-left handle only, not the whole
 * card (a full-card grab cursor over something you mostly just click to open
 * felt wrong) — same pointer-events technique as `Features/Uptime/ServiceCard`
 * otherwise (see `AccountList` for why). Both corners fade in on hover/focus
 * so the tile stays calm at rest.
 */
export function AccountCard({
    account,
    selected,
    busy,
    dragging,
    onOpen,
    onEdit,
    onToggle,
    onDragPointerDown
}: AccountCardProps) {
    const action = (run: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        run();
    };

    // Quelqu'un travaille dans ce compte, plus bas que moi : sa couleur ici.
    const outline = useLiveOutline('l1', String(account.id));
    const status = describeAccountStatus(account);

    return (
        <div
            className={`${styles.accountCard} ${selected ? styles.accountCardSelected : ''} ${
                account.enabled ? '' : styles.accountCardPaused
            } ${dragging ? styles.accountCardDragging : ''}`}
            {...outline}
            role='button'
            tabIndex={0}
            data-account-card=''
            onClick={onOpen}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen();
                }
            }}
        >
            {account.syncing && <SyncProgressBar progress={account.syncProgress} />}

            <span
                className={`icon icon-drag ${styles.accountCardHandle}`}
                aria-hidden='true'
                onPointerDown={onDragPointerDown}
            />

            <div className={styles.accountCardCorner}>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title='Modifier'
                    aria-label='Modifier'
                    onClick={action(onEdit)}
                >
                    <span className='icon icon-edit' />
                </button>
                <button
                    type='button'
                    className={styles.iconBtn}
                    disabled={busy}
                    title={account.enabled ? 'Mettre en pause' : 'Réactiver'}
                    aria-label={account.enabled ? 'Mettre en pause' : 'Réactiver'}
                    onClick={action(onToggle)}
                >
                    <span className={`icon icon-${account.enabled ? 'pause' : 'play'}`} />
                </button>
            </div>

            <span
                className={`icon icon-${account.securityTier === 'guarded' ? 'lock' : 'unlock'} ${styles.accountCardIcon}`}
            />
            <h4 className={styles.accountCardName}>{account.displayName}</h4>
            <p className={styles.accountCardEmail}>{account.emailAddress}</p>
            <span className={styles.accountCardBadgeSlot}>
                {status && <StatusBadge tone={status.tone}>{status.badge}</StatusBadge>}
            </span>
            <p className={styles.accountCardMeta}>
                {formatAgo(account.lastSyncAt)}
                {account.lastSyncError && ` · ${account.lastSyncError}`}
            </p>
        </div>
    );
}

export default AccountCard;

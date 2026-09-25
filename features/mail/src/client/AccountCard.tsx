import { PlanPausedBadge, StatusBadge, useLiveOutline } from 'deveye-sdk-client';

import { describeAccountStatus } from './accountStatus';
import SyncProgressBar from './SyncProgressBar';
import styles from './style.module.css';

import type { MailAccount } from '../contracts/domain';

interface AccountCardProps {
    account: MailAccount;
    selected: boolean;
    busy: boolean;
    dragging: boolean;
    onOpen: () => void;
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
 * One configured mail account, as a centered tile. Deleting lives one step
 * further away, in the edit popup's own danger button, and that popup is the
 * only route to it, which is why the edit button shows for every account: an
 * OAuth mailbox opens it read-only, but it does open.
 *
 * The drag grab surface is the small top-left handle only, not the whole card;
 * both corners fade in on hover/focus so the tile stays calm at rest.
 *
 * Un compte projeté d'un autre espace (`foreign`) porte une pastille et perd le
 * bouton d'édition : le formulaire qu'il ouvre réécrit les identifiants et porte
 * la suppression, deux gestes que le serveur réserve au domicile. La pause reste :
 * suspendre la relève de ce qu'on voit est un geste de fenêtre.
 */
export function AccountCard({
    account,
    selected,
    busy,
    dragging,
    onOpen,
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
                {/* Projetée depuis un autre espace : elle se lit et se relève
                    comme les autres, mais rien ne distinguerait sinon une boîte
                    d'ici d'une fenêtre sur l'espace voisin. Même pastille que
                    les services Uptime. */}
                {account.foreign && (
                    <span title='Cette boîte appartient à un autre espace qui la partage ici'>
                        <StatusBadge tone='accent'>partagée</StatusBadge>
                    </span>
                )}
                {account.planPaused && <PlanPausedBadge />}
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

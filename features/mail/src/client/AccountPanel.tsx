import { StatusBadge } from 'deveye-sdk-client';

import AccountList from './AccountList';
import AccountOptions from './AccountOptions';
import FolderTree from './FolderTree';
import SyncProgressBar from './SyncProgressBar';
import styles from './style.module.css';

import type { MailAccount, MailFolder } from '../contracts/domain';

interface AccountPanelProps {
    accounts: MailAccount[];
    selectedId: number | null;
    busy: ReadonlySet<number>;
    onSelect: (account: MailAccount) => void;
    onEdit: (account: MailAccount) => void;
    onToggle: (account: MailAccount) => void;
    onReorder: (ids: number[]) => void;
    /** A card is being dragged — the host pauses its polling meanwhile. */
    onDragStateChange: (dragging: boolean) => void;
    onAdd: () => void;
    folders: MailFolder[];
    foldersLoading: boolean;
    selectedFolderId: number | null;
    onSelectFolder: (folder: MailFolder) => void;
    /** Which slide shows — controlled by the host, which also sizes the column around it. */
    showList: boolean;
    onShowList: () => void;
    /** Per-account actions, shown on slide 2 between the account header and its folders. */
    onDeleteAccount: (account: MailAccount) => void;
    onRefreshFolder: () => void;
    refreshingFolder: boolean;
}

/**
 * Panel A: a two-slide horizontal track, twice this panel's width with half of
 * it always off to the side. The left slide is the full account list (drag & drop
 * reorder included), where you land when nothing is selected; the right slide is
 * the selected account, as a small card with a back arrow, plus its folder tree.
 *
 * Which slide shows is controlled by the host, independent of the actual
 * selection: picking an account always slides right, but the back arrow only
 * changes the view, the account staying selected (panel B keeps showing its
 * messages) until another one is picked. The host uses the same bit of state to
 * widen the column while the list is showing, its content needing more room.
 */
export function AccountPanel({
    accounts,
    selectedId,
    busy,
    onSelect,
    onEdit,
    onToggle,
    onReorder,
    onDragStateChange,
    onAdd,
    folders,
    foldersLoading,
    selectedFolderId,
    onSelectFolder,
    showList,
    onShowList,
    onDeleteAccount,
    onRefreshFolder,
    refreshingFolder
}: AccountPanelProps) {
    const selected = accounts.find((a) => a.id === selectedId) ?? null;

    return (
        <div className={styles.panelA}>
            <div className={styles.panelATrack} style={{ transform: showList ? 'translateX(0)' : 'translateX(-50%)' }}>
                <div className={styles.panelASlide}>
                    <div className={styles.accountListScroll}>
                        <AccountList
                            accounts={accounts}
                            selectedId={selectedId}
                            busy={busy}
                            onOpen={onSelect}
                            onEdit={onEdit}
                            onToggle={onToggle}
                            onReorder={onReorder}
                            onDragStateChange={onDragStateChange}
                        />
                    </div>
                    {/* Sibling of the scroll area, not a child of it: inside, its
                        `margin-top: auto` left it clipped once the list overflowed. */}
                    <button type='button' className={styles.accountAddBtn} onClick={onAdd}>
                        <span className='icon icon-plus' /> Ajouter une boîte mail
                    </button>
                </div>

                <div className={styles.panelASlide}>
                    {selected && (
                        <>
                            <button type='button' className={styles.selectedAccountCard} onClick={onShowList}>
                                {selected.syncing && <SyncProgressBar progress={selected.syncProgress} />}
                                <span className='icon icon-arrow-left' />
                                <span
                                    className={`icon icon-${selected.securityTier === 'guarded' ? 'lock' : 'unlock'}`}
                                />
                                <span className={styles.selectedAccountText}>
                                    <span className={styles.selectedAccountName}>{selected.displayName}</span>
                                    <span className={styles.selectedAccountEmail}>{selected.emailAddress}</span>
                                </span>
                                {/* La même pastille que sur sa carte : cette face ne
                                    montre plus la liste. */}
                                {selected.foreign && (
                                    <span title='Cette boîte appartient à un autre espace qui la partage ici'>
                                        <StatusBadge tone='accent'>partagée</StatusBadge>
                                    </span>
                                )}
                            </button>
                            <AccountOptions
                                canRefresh={selectedFolderId !== null}
                                refreshing={refreshingFolder}
                                foreign={selected.foreign}
                                onEdit={() => onEdit(selected)}
                                onRefresh={onRefreshFolder}
                                onDelete={() => onDeleteAccount(selected)}
                            />
                            <div className={styles.folderScroll}>
                                <h4 className={styles.sidebarSubhead}>Dossiers</h4>
                                {foldersLoading ? (
                                    <p className={styles.empty}>Chargement…</p>
                                ) : (
                                    <FolderTree
                                        folders={folders}
                                        selectedId={selectedFolderId}
                                        onSelect={onSelectFolder}
                                    />
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AccountPanel;

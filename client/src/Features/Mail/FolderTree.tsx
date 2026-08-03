import styles from './style.module.css';

import type { MailFolder } from 'deveye-types';

interface FolderTreeProps {
    folders: MailFolder[];
    selectedId: number | null;
    onSelect: (folder: MailFolder) => void;
}

const SPECIAL_ICONS: Record<string, string> = {
    inbox: 'home',
    // `arrow` points right (outgoing) — `arrow-left` here read backwards for "Sent".
    sent: 'arrow',
    drafts: 'edit',
    trash: 'trash',
    junk: 'shield',
    archive: 'archive'
};

/** Plain sorted list — folder drag & drop reorder is a V2 nicety, not V1 scope. */
export function FolderTree({ folders, selectedId, onSelect }: FolderTreeProps) {
    return (
        <div className={styles.folderTree}>
            {folders.map((folder) => (
                <button
                    key={folder.id}
                    type='button'
                    className={`${styles.folderRow} ${selectedId === folder.id ? styles.folderRowSelected : ''}`}
                    onClick={() => onSelect(folder)}
                >
                    <span className={`icon icon-${SPECIAL_ICONS[folder.specialUse] ?? 'folder'}`} />
                    <span className={styles.folderName}>{folder.name}</span>
                    {folder.unreadCount > 0 && <span className={styles.folderUnread}>{folder.unreadCount}</span>}
                </button>
            ))}
        </div>
    );
}

export default FolderTree;

import { CountBadge, useLiveOutlines } from 'deveye-sdk-client';

import styles from './style.module.css';

import type { MailFolder } from '../contracts/domain';

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

export function FolderTree({ folders, selectedId, onSelect }: FolderTreeProps) {
    // Quelqu'un est dans l'un de ces dossiers : sa couleur sur la ligne. La
    // forme liste évite d'extraire un composant par ligne juste pour un hook.
    const outlineOf = useLiveOutlines('l2');
    return (
        <div className={styles.folderTree}>
            {folders.map((folder) => (
                <button
                    key={folder.id}
                    type='button'
                    className={`${styles.folderRow} ${selectedId === folder.id ? styles.folderRowSelected : ''}`}
                    onClick={() => onSelect(folder)}
                    {...outlineOf(String(folder.id))}
                >
                    <span className={`icon icon-${SPECIAL_ICONS[folder.specialUse] ?? 'folder'}`} />
                    <span className={styles.folderName}>{folder.name}</span>
                    {folder.unreadCount > 0 && (
                        <CountBadge count={folder.unreadCount} aria-label={`${folder.unreadCount} unread`} />
                    )}
                </button>
            ))}
        </div>
    );
}

export default FolderTree;

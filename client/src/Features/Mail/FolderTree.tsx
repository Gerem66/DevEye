import styles from './style.module.css';

import type { MailFolder } from 'deveye-types';
import { useLiveOutline } from '@/live/useLiveOutline';

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
                <FolderRow key={folder.id} folder={folder} selected={selectedId === folder.id} onSelect={onSelect} />
            ))}
        </div>
    );
}

/** Une ligne, extraite parce qu'elle porte un hook (la bordure de présence). */
function FolderRow({
    folder,
    selected,
    onSelect
}: {
    folder: MailFolder;
    selected: boolean;
    onSelect: (folder: MailFolder) => void;
}) {
    // Quelqu'un est dans ce dossier, plus bas que moi : sa couleur ici.
    const outline = useLiveOutline('folder', String(folder.id));
    return (
        <>
            <button
                type='button'
                className={`${styles.folderRow} ${selected ? styles.folderRowSelected : ''}`}
                onClick={() => onSelect(folder)}
                {...outline}
            >
                <span className={`icon icon-${SPECIAL_ICONS[folder.specialUse] ?? 'folder'}`} />
                <span className={styles.folderName}>{folder.name}</span>
                {folder.unreadCount > 0 && <span className={styles.folderUnread}>{folder.unreadCount}</span>}
            </button>
        </>
    );
}

export default FolderTree;

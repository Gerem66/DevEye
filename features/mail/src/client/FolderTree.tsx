import { ActionMenu, CountBadge, useLiveOutlines, type ActionMenuItem } from 'deveye-sdk-client';

import styles from './style.module.css';

import type { MailFolder } from '../contracts/domain';

/** Ce que le menu ⋯ d'un dossier propose ; l'hôte fait le geste. */
export type FolderAction = 'markAllRead' | 'addChild' | 'rename' | 'delete';

interface FolderTreeProps {
    folders: MailFolder[];
    selectedId: number | null;
    onSelect: (folder: MailFolder) => void;
    onAction: (folder: MailFolder, action: FolderAction) => void;
}

const SPECIAL_ICONS: Record<string, string> = {
    inbox: 'home',
    // `arrow` points right (outgoing) : `arrow-left` here read backwards for "Sent".
    sent: 'arrow',
    drafts: 'edit',
    trash: 'trash',
    junk: 'shield',
    archive: 'archive'
};

/**
 * Renommer et supprimer ne sont offerts qu'à un dossier ordinaire : un dossier
 * à rôle (réception, envoyés, corbeille…) est refusé par le serveur, et un
 * bouton qui ouvre sur un refus est un écran qui ment.
 */
function menuItems(folder: MailFolder, onAction: FolderTreeProps['onAction']): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
        { label: 'Tout marquer comme lu', icon: 'eye-open', onSelect: () => onAction(folder, 'markAllRead') },
        { label: 'Nouveau sous-dossier', icon: 'folder', onSelect: () => onAction(folder, 'addChild') }
    ];
    if (folder.specialUse === 'other') {
        items.push(
            { label: 'Renommer', icon: 'edit', onSelect: () => onAction(folder, 'rename') },
            { label: 'Supprimer', icon: 'trash', danger: true, onSelect: () => onAction(folder, 'delete') }
        );
    }
    return items;
}

export function FolderTree({ folders, selectedId, onSelect, onAction }: FolderTreeProps) {
    // Quelqu'un est dans l'un de ces dossiers : sa couleur sur la ligne. La
    // forme liste évite d'extraire un composant par ligne juste pour un hook.
    const outlineOf = useLiveOutlines('l2');
    return (
        <div className={styles.folderTree}>
            {folders.map((folder) => (
                <div key={folder.id} className={styles.folderItem} {...outlineOf(String(folder.id))}>
                    <button
                        type='button'
                        className={`${styles.folderRow} ${selectedId === folder.id ? styles.folderRowSelected : ''}`}
                        onClick={() => onSelect(folder)}
                    >
                        <span className={`icon icon-${SPECIAL_ICONS[folder.specialUse] ?? 'folder'}`} />
                        <span className={styles.folderName}>{folder.name}</span>
                        {folder.unreadCount > 0 && (
                            <CountBadge
                                count={folder.unreadCount}
                                aria-label={`${folder.unreadCount} non lu${folder.unreadCount > 1 ? 's' : ''}`}
                            />
                        )}
                    </button>
                    <ActionMenu
                        className={styles.folderMenu}
                        label={`Actions sur « ${folder.name} »`}
                        items={menuItems(folder, onAction)}
                    />
                </div>
            ))}
        </div>
    );
}

export default FolderTree;

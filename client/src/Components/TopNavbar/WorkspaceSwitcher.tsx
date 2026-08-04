import { useWorkspaceState } from '@/stores/workspace';
import styles from './TopNavbar.module.css';

export interface WorkspaceSwitcherProps {
    /** Bascule vers un autre espace (recharge la session). */
    onSelect: (workspaceId: number) => void;
    /** Ouvre la création d'un espace. */
    onCreate: () => void;
}

/**
 * Section « Espaces » du menu de la topbar.
 *
 * Volontairement plate : la liste complète est visible d'un coup, sans sous-menu
 * ni repli, parce qu'un utilisateur en a une poignée et que le but est de
 * basculer en un clic. L'espace personnel arrive toujours en tête — le serveur
 * le trie ainsi.
 */
export function WorkspaceSwitcher({ onSelect, onCreate }: WorkspaceSwitcherProps) {
    const { workspaces, activeId } = useWorkspaceState();

    // Un seul espace : proposer d'en créer un suffit, lister l'unique entrée
    // n'apporterait rien.
    const showList = workspaces.length > 1;

    return (
        <>
            <hr className={styles.divider} />
            <div className={styles.menuLabel}>Espaces</div>

            {showList &&
                workspaces.map((w) => {
                    const current = w.id === activeId;
                    return (
                        <button
                            key={w.id}
                            className={`${styles.menuItem} ${styles.workspaceItem} ${current ? styles.current : ''}`}
                            onClick={() => onSelect(w.id)}
                            aria-current={current ? 'true' : undefined}
                            title={w.name}
                        >
                            <span className={`icon ${w.kind === 'personal' ? 'icon-user-outline' : 'icon-users'}`} />
                            <span className={styles.workspaceName}>{w.name}</span>
                            {current && <span className={`icon icon-v ${styles.workspaceCheck}`} />}
                        </button>
                    );
                })}

            <button className={styles.menuItem} onClick={onCreate}>
                <span className='icon icon-plus' /> Nouvel espace
            </button>
        </>
    );
}

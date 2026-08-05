import type React from 'react';
import { useWorkspaceState } from '@/stores/workspace';
import styles from './TopNavbar.module.css';

export interface WorkspaceSwitcherProps {
    /** Bascule vers un autre espace (recharge la session). */
    onSelect: (workspaceId: number) => void;
    /** Ouvre la création d'un espace. */
    onCreate: () => void;
    /** Ouvre la page de gestion de l'espace courant. */
    onManage: (e: React.MouseEvent) => void;
}

/**
 * Section « Espaces » du menu de la topbar, en tête.
 *
 * Volontairement plate : la liste complète est visible d'un coup, sans sous-menu
 * ni repli, parce qu'un utilisateur en a une poignée et que le but est de
 * basculer en un clic. L'espace personnel arrive toujours en tête — le serveur
 * le trie ainsi.
 */
export function WorkspaceSwitcher({ onSelect, onCreate, onManage }: WorkspaceSwitcherProps) {
    const { workspaces, activeId } = useWorkspaceState();
    const active = workspaces.find((w) => w.id === activeId) ?? null;

    // Un seul espace : proposer d'en créer un suffit, lister l'unique entrée
    // n'apporterait rien.
    const showList = workspaces.length > 1;

    return (
        <>
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

            {/* La gestion n'a de sens que sur un espace partagé : le personnel
                n'a ni membres, ni invitations, et ne se quitte pas. */}
            {active?.kind === 'shared' && (
                <button className={styles.menuItem} onClick={onManage}>
                    <span className='icon icon-settings' /> Gérer l’espace
                </button>
            )}

            {/* Le trait ferme la section au lieu de l'ouvrir : elle est en tête de
                menu, un filet au-dessus n'y séparerait rien. */}
            <hr className={styles.divider} />
        </>
    );
}

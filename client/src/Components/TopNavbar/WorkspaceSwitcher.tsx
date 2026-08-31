import { Fragment } from 'react';
import type React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWorkspaceState } from '@/stores/workspace';
import styles from './TopNavbar.module.css';

/** Le dépli de « Gérer cet espace » quand la bascule change d'espace courant. */
const REVEAL = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

export interface WorkspaceSwitcherProps {
    /** Bascule vers un autre espace (recharge la session). */
    onSelect: (workspaceId: number) => void;
    /** Ouvre la création d'un espace. */
    onCreate: () => void;
    /** Ouvre la page de gestion de l'espace courant. */
    onManage: (e: React.MouseEvent) => void;
}

/**
 * Section « Espaces » du menu de la topbar : liste plate, visible d'un coup,
 * pour basculer en un clic. L'espace personnel arrive en tête (tri serveur), et
 * la gestion se range sous celui où l'on se trouve.
 */
export function WorkspaceSwitcher({ onSelect, onCreate, onManage }: WorkspaceSwitcherProps) {
    const { workspaces, activeId } = useWorkspaceState();

    // Un seul espace : c'est le personnel, qui n'a rien à gérer. Proposer d'en
    // créer un suffit, lister l'unique entrée n'apporterait rien.
    const showList = workspaces.length > 1;

    return (
        <>
            {/* La création vit sur l'intitulé de la section, pas dans la liste :
                c'est une action sur l'ensemble, pas un espace de plus à choisir. */}
            <div className={styles.menuLabel}>
                <span>Espaces</span>
                <button
                    type='button'
                    className={styles.menuLabelAction}
                    onClick={onCreate}
                    title='Nouvel espace'
                    aria-label='Nouvel espace'
                >
                    <span className='icon icon-plus' />
                </button>
            </div>

            {showList &&
                workspaces.map((w) => {
                    const current = w.id === activeId;
                    return (
                        <Fragment key={w.id}>
                            <button
                                className={`${styles.menuItem} ${styles.workspaceItem} ${current ? styles.current : ''}`}
                                onClick={() => onSelect(w.id)}
                                aria-current={current ? 'true' : undefined}
                                title={w.name}
                            >
                                <span
                                    className={`icon ${w.kind === 'personal' ? 'icon-user-outline' : 'icon-users'}`}
                                />
                                <span className={styles.workspaceText}>
                                    <span className={styles.workspaceName}>{w.name}</span>
                                    {w.kind === 'shared' && (
                                        <span className={styles.workspaceMeta}>
                                            Partagé · {w.users.length} membre{w.users.length > 1 ? 's' : ''}
                                        </span>
                                    )}
                                </span>
                                {current && <span className={`icon icon-v ${styles.workspaceCheck}`} />}
                            </button>

                            {/* En retrait sous l'espace courant : le décalage dit sur
                                quoi elle agit. `initial={false}` la pose sans
                                animation à l'ouverture du menu, elle ne se déplie
                                qu'en changeant d'espace. Le personnel, lui, n'a
                                ni membres, ni rôles, et ne se quitte pas. */}
                            <AnimatePresence initial={false}>
                                {current && w.kind === 'shared' && (
                                    <motion.div
                                        className={styles.manageReveal}
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={REVEAL}
                                    >
                                        <button
                                            className={`${styles.menuItem} ${styles.manageItem}`}
                                            onClick={onManage}
                                        >
                                            <span className='icon icon-settings' /> Gérer cet espace
                                        </button>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </Fragment>
                    );
                })}

            {/* Le trait ferme la section au lieu de l'ouvrir : elle est en tête de
                menu, un filet au-dessus n'y séparerait rien. */}
            <hr className={styles.divider} />
        </>
    );
}

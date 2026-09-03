import { Fragment } from 'react';
import type React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWorkspaceState } from '@/stores/workspace';
import styles from './TopNavbar.module.css';

/** Le dépli des actions de l'espace quand la bascule change d'espace courant. */
const REVEAL = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

export interface WorkspaceSwitcherProps {
    /** Bascule vers un autre espace (recharge la session). */
    onSelect: (workspaceId: number) => void;
    /** Ouvre la création d'un espace. */
    onCreate: () => void;
    /** Ouvre l'apparence de l'espace courant. Absent = pas le droit. */
    onAppearance?: () => void;
    /** Passe l'accueil de l'espace courant en organisation. Absent = pas le droit. */
    onOrganize?: () => void;
    /** Ouvre la page de gestion de l'espace courant. */
    onManage: (e: React.MouseEvent) => void;
}

/**
 * Section « Espaces » du menu de la topbar : liste plate, visible d'un coup,
 * pour basculer en un clic. L'espace personnel arrive en tête (tri serveur), et
 * tout ce qui agit sur un espace se range sous celui où l'on se trouve.
 */
export function WorkspaceSwitcher({ onSelect, onCreate, onAppearance, onOrganize, onManage }: WorkspaceSwitcherProps) {
    const { workspaces, activeId } = useWorkspaceState();

    // La gestion est le seul geste réservé aux partagés : le personnel n'a ni
    // membres, ni rôles, et ne se quitte pas.
    const manageable = workspaces.find((w) => w.id === activeId)?.kind === 'shared';
    const hasActions = Boolean(onAppearance || onOrganize || manageable);

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

            {/* La liste est rendue même à un seul espace, le personnel : c'est la
                ligne d'un espace qui donne son sens au retrait sous elle, et sans
                elle ses actions ne désigneraient plus rien. */}
            {workspaces.map((w) => {
                const current = w.id === activeId;
                return (
                    <Fragment key={w.id}>
                        <button
                            className={`${styles.menuItem} ${styles.workspaceItem} ${current ? styles.current : ''}`}
                            onClick={() => onSelect(w.id)}
                            aria-current={current ? 'true' : undefined}
                            title={w.name}
                        >
                            <span className={`icon ${w.kind === 'personal' ? 'icon-user-outline' : 'icon-users'}`} />
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
                                quoi elles agissent, et de la plus courante à la plus
                                rare. `initial={false}` les pose sans animation à
                                l'ouverture du menu, elles ne se déplient qu'en
                                changeant d'espace. */}
                        <AnimatePresence initial={false}>
                            {current && hasActions && (
                                <motion.div
                                    className={styles.workspaceActions}
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={REVEAL}
                                >
                                    {onAppearance && (
                                        <button
                                            className={`${styles.menuItem} ${styles.workspaceAction}`}
                                            onClick={onAppearance}
                                        >
                                            <span className='icon icon-appearance' /> Apparence
                                        </button>
                                    )}
                                    {onOrganize && (
                                        <button
                                            className={`${styles.menuItem} ${styles.workspaceAction}`}
                                            onClick={onOrganize}
                                        >
                                            <span className='icon icon-edit' /> Organiser l’accueil
                                        </button>
                                    )}
                                    {manageable && (
                                        <button
                                            className={`${styles.menuItem} ${styles.workspaceAction}`}
                                            onClick={onManage}
                                        >
                                            <span className='icon icon-settings' /> Gérer cet espace
                                        </button>
                                    )}
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

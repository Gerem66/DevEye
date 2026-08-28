import { useEffect, useRef, useState } from 'react';
import { useDismissLayer, type LiveOutlineProps } from 'deveye-sdk-client';
import type { ProjectFeatureTab, ProjectTab, ProjectTabAddAction, ProjectTabId } from './tabs';
import type { ProjectTabAddable } from './useProjectTabs';
import styles from './style.module.css';

interface ProjectTabsProps {
    /** Les onglets à montrer, dans l'ordre. */
    tabs: ProjectTab[];
    active: ProjectTabId;
    onSelect: (id: ProjectTabId) => void;
    /** Les gestes repliés dans le « + ». Vide = pas de bouton du tout. */
    addable: ProjectTabAddable[];
    onAdd: (tab: ProjectFeatureTab, action: ProjectTabAddAction) => void;
    /** Les contours de présence du niveau `l2` (voir LIVE.md). */
    outline: (value: string | null) => LiveOutlineProps;
}

/**
 * La barre d'onglets d'un projet, et le « + » qui tient les absents.
 *
 * Le bouton est en **bout de barre**, là où l'œil arrive après avoir lu ce qui
 * existe : ce qu'il ouvre est précisément ce qui n'existe pas encore.
 */
export function ProjectTabs({ tabs, active, onSelect, addable, onAdd, outline }: ProjectTabsProps) {
    return (
        <nav className={styles.tabs}>
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    type='button'
                    className={tab.id === active ? styles.tabActive : styles.tab}
                    aria-current={tab.id === active ? 'page' : undefined}
                    onClick={() => onSelect(tab.id)}
                    {...outline(`tab:${tab.id}`)}
                >
                    <span className={`icon icon-${tab.icon}`} /> {tab.label}
                </button>
            ))}

            {addable.length > 0 && <AddTabMenu addable={addable} onAdd={onAdd} />}
        </nav>
    );
}

/**
 * Le menu des gestes dont l'onglet n'est pas encore dans la barre.
 *
 * Chaque entrée nomme l'onglet **et** le geste qu'elle déclenche : le clic
 * n'ouvre pas un onglet vide, il ouvre le formulaire d'ajout correspondant — le
 * même que le bouton « Ajouter un… » de l'onglet. Celui-ci, lui, naît de ce
 * qu'on y met. Un onglet à plusieurs gestes (Déploiement, tant qu'il n'a ni
 * cible ni service surveillé) y occupe donc plusieurs lignes, une par geste.
 *
 * Se ferme au choix, au clic à l'extérieur, ou par Échap — cette dernière par
 * la pile de couches partagée, pour que le menu parte avant la popup qui le
 * porte, et non l'inverse.
 */
function AddTabMenu({ addable, onAdd }: Pick<ProjectTabsProps, 'addable' | 'onAdd'>) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useDismissLayer(open, () => setOpen(false));

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open]);

    return (
        <div className={styles.tabAddWrap} ref={rootRef}>
            <button
                type='button'
                className={open ? styles.tabAddOpen : styles.tabAdd}
                onClick={() => setOpen((v) => !v)}
                title='Ajouter une intégration au projet'
                aria-label='Ajouter une intégration au projet'
                aria-haspopup='menu'
                aria-expanded={open}
            >
                <span className='icon icon-plus' />
            </button>

            {open && (
                <div className={styles.tabMenu} role='menu'>
                    {addable.map(({ tab, action }) => (
                        <button
                            key={action.key}
                            type='button'
                            role='menuitem'
                            className={styles.tabMenuItem}
                            onClick={() => {
                                setOpen(false);
                                onAdd(tab, action);
                            }}
                        >
                            <span className={`icon icon-${action.icon ?? tab.icon} ${styles.tabMenuIcon}`} />
                            <span className={styles.tabMenuText}>
                                {tab.label}
                                <span className={styles.tabMenuHint}>{action.label}</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export default ProjectTabs;

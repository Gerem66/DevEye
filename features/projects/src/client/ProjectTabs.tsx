import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDismissLayer, useRequestPopupWidth, type LiveOutlineProps } from 'deveye-sdk-client';
import { tabsNaturalWidth } from './Board/width';
import type { ProjectFeatureTab, ProjectTab, ProjectTabAddAction, ProjectTabId } from './tabs';
import type { ProjectTabAddable } from './useProjectTabs';
import styles from './style.module.css';

interface ProjectTabsProps {
    tabs: ProjectTab[];
    active: ProjectTabId;
    onSelect: (id: ProjectTabId) => void;
    /** Les gestes repliés dans le « + ». Vide = pas de bouton du tout. */
    addable: ProjectTabAddable[];
    onAdd: (tab: ProjectFeatureTab, action: ProjectTabAddAction) => void;
    /** Les contours de présence du niveau `l2` (voir LIVE.md). */
    outline: (value: string | null) => LiveOutlineProps;
}

export function ProjectTabs({ tabs, active, onSelect, addable, onAdd, outline }: ProjectTabsProps) {
    const navRef = useRef<HTMLElement>(null);
    const ghostRef = useRef<HTMLDivElement>(null);
    const [compact, setCompact] = useState(false);
    /** La largeur de la barre tous libellés dépliés ; `null` avant la première mesure. */
    const [naturalWidth, setNaturalWidth] = useState<number | null>(null);

    // La popup s'élargit pour loger les libellés quand l'écran a de la marge ;
    // le store écrête à la fenêtre, et sans marge la barre se replie comme avant.
    useRequestPopupWidth(naturalWidth === null ? null : tabsNaturalWidth(naturalWidth));

    /*
     * Les libellés tiennent-ils ? La question se pose à la rangée fantôme, qui
     * est toujours dépliée : mesurer la barre rendue la ferait basculer sans
     * fin, puisque le repli la rétrécit sous le seuil qui l'a déclenché.
     */
    useLayoutEffect(() => {
        const nav = navRef.current;
        const ghost = ghostRef.current;
        if (!nav || !ghost) return;
        const measure = () => {
            const natural = Math.ceil(ghost.getBoundingClientRect().width);
            setNaturalWidth(natural);
            setCompact(natural > nav.clientWidth);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(nav);
        observer.observe(ghost);
        return () => observer.disconnect();
    }, [tabs, addable.length]);

    return (
        <div className={styles.tabsWrap}>
            <nav className={styles.tabs} ref={navRef} data-compact={compact ? '' : undefined}>
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        type='button'
                        className={tab.id === active ? styles.tabActive : styles.tab}
                        aria-current={tab.id === active ? 'page' : undefined}
                        // Réduit à son icône, l'onglet n'a plus que ça à dire.
                        title={tab.label}
                        onClick={() => onSelect(tab.id)}
                        {...outline(`tab:${tab.id}`)}
                    >
                        <span className={`icon icon-${tab.icon}`} aria-hidden='true' />
                        <span className={styles.tabLabel}>
                            <span>{tab.label}</span>
                        </span>
                    </button>
                ))}

                {addable.length > 0 && <AddTabMenu addable={addable} onAdd={onAdd} />}
            </nav>

            <div className={styles.tabsGhost} aria-hidden='true' ref={ghostRef}>
                {tabs.map((tab) => (
                    <span key={tab.id} className={styles.tab}>
                        <span className={`icon icon-${tab.icon}`} />
                        <span className={styles.tabLabel}>
                            <span>{tab.label}</span>
                        </span>
                    </span>
                ))}
                {addable.length > 0 && <span className={styles.tabAdd} />}
            </div>
        </div>
    );
}

/**
 * Le menu des gestes dont l'onglet n'est pas encore dans la barre : une entrée
 * par geste, qui ouvre le formulaire d'ajout et non un onglet vide. Échap passe
 * par la pile de couches partagée, pour que le menu parte avant sa popup.
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
                            <span className={`icon icon-${tab.icon} ${styles.tabMenuIcon}`} />
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

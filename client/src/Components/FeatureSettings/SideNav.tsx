import { Fragment, useEffect, useRef } from 'react';

import styles from './FeatureSettings.module.css';

export interface SideNavItem<T extends string> {
    id: T;
    label: string;
    /** Classe d'icône de `Styles/icons.css`, sans le préfixe `icon-`. */
    icon: string;
    /** Compteur affiché en pastille. Omis quand il n'apporte rien. */
    badge?: number;
    /** `accent` : le compteur réclame une action, comme les badges du menu du compte. */
    badgeTone?: 'accent';
    /** La catégorie : son titre précède la première entrée qui la porte. Les entrées d'une catégorie se suivent. */
    group?: string;
}

export interface SideNavProps<T extends string> {
    items: SideNavItem<T>[];
    /** `undefined` le temps qu'une liste vide se remplisse : aucune entrée n'est
     *  alors marquée, plutôt qu'une entrée choisie au hasard. */
    active: T | undefined;
    onSelect: (id: T) => void;
    /** Libellé lu par les lecteurs d'écran — « Réglages d'Uptime ». */
    label: string;
}

/**
 * La colonne de gauche de la coquille de réglages. Verticale : les sections
 * sont des catégories, non des vues d'un même objet, et les intitulés entiers
 * se lisent de haut en bas. Les entrées sont construites par l'appelant en
 * fonction des droits ; sans aucune, c'est le bouton qui ouvre la coquille qui
 * disparaît (`FeatureSettingsButton`).
 */
export default function SideNav<T extends string>({ items, active, onSelect, label }: SideNavProps<T>) {
    const navRef = useRef<HTMLElement>(null);

    // En rangée défilante (écran étroit), l'entrée active peut naître hors champ.
    // `scrollLeft` et non `scrollIntoView`, qui ferait aussi défiler la popup ; et
    // à chaque taille, la vue d'une popup étant montée avant d'être affichée.
    useEffect(() => {
        const nav = navRef.current;
        if (!nav) return;
        const reveal = () => {
            if (nav.scrollWidth <= nav.clientWidth) return;
            const current = nav.querySelector<HTMLElement>('[aria-selected="true"]');
            if (!current) return;
            const box = nav.getBoundingClientRect();
            const item = current.getBoundingClientRect();
            if (item.left < box.left || item.right > box.right) {
                nav.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
            }
        };
        reveal();
        const observer = new ResizeObserver(reveal);
        observer.observe(nav);
        return () => observer.disconnect();
    }, [active]);

    return (
        <nav ref={navRef} className={styles.nav} role='tablist' aria-label={label}>
            {items.map((item, i) => (
                <Fragment key={item.id}>
                    {item.group !== undefined && item.group !== items[i - 1]?.group && (
                        <span className={styles.navGroup} role='presentation'>
                            {item.group}
                        </span>
                    )}
                    <button
                        type='button'
                        role='tab'
                        aria-selected={item.id === active}
                        className={`${styles.navItem} ${item.id === active ? styles.navItemActive : ''}`}
                        onClick={() => onSelect(item.id)}
                    >
                        <span className={`icon icon-${item.icon}`} />
                        <span className={styles.navLabel}>{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                            <span
                                className={`${styles.navBadge} ${item.badgeTone === 'accent' ? styles.navBadgeAccent : ''}`}
                            >
                                {item.badge}
                            </span>
                        )}
                    </button>
                </Fragment>
            ))}
        </nav>
    );
}

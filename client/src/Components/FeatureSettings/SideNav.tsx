import styles from './FeatureSettings.module.css';

export interface SideNavItem<T extends string> {
    id: T;
    label: string;
    /** Classe d'icône de `Styles/icons.css`, sans le préfixe `icon-`. */
    icon: string;
    /** Compteur affiché en pastille. Omis quand il n'apporte rien. */
    badge?: number;
}

export interface SideNavProps<T extends string> {
    items: SideNavItem<T>[];
    active: T;
    onSelect: (id: T) => void;
    /** Libellé lu par les lecteurs d'écran — « Réglages d'Uptime ». */
    label: string;
}

/**
 * La colonne de gauche de la coquille de réglages.
 *
 * Verticale et non horizontale, contrairement aux `Tabs` de l'écran Espace : les
 * sections d'un réglage sont des **catégories** (où partent les alertes, qui a
 * le droit, où la donnée est visible) et non des vues d'un même objet. Elles
 * s'énumèrent donc de haut en bas, où l'on peut lire des intitulés entiers
 * plutôt que de les tronquer.
 *
 * Comme les onglets, les entrées sont **construites par l'appelant en fonction
 * des droits** : une section affichée mène toujours à quelque chose
 * d'utilisable, plutôt qu'à un panneau vide ou grisé. Et quand il n'en reste
 * aucune, ce n'est pas cette barre qui disparaît — c'est le bouton qui ouvre la
 * coquille (voir `FeatureSettingsButton`).
 */
export default function SideNav<T extends string>({ items, active, onSelect, label }: SideNavProps<T>) {
    return (
        <nav className={styles.nav} role='tablist' aria-label={label}>
            {items.map((item) => (
                <button
                    key={item.id}
                    type='button'
                    role='tab'
                    aria-selected={item.id === active}
                    className={`${styles.navItem} ${item.id === active ? styles.navItemActive : ''}`}
                    onClick={() => onSelect(item.id)}
                >
                    <span className={`icon icon-${item.icon}`} />
                    <span className={styles.navLabel}>{item.label}</span>
                    {item.badge !== undefined && item.badge > 0 && (
                        <span className={styles.navBadge}>{item.badge}</span>
                    )}
                </button>
            ))}
        </nav>
    );
}

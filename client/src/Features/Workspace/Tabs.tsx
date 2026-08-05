import styles from './Workspace.module.css';

export interface TabDef<T extends string> {
    id: T;
    label: string;
    icon: string;
    /** Compteur affiché en pastille. Omis quand il n'apporte rien. */
    badge?: number;
}

export interface TabsProps<T extends string> {
    tabs: TabDef<T>[];
    active: T;
    onSelect: (id: T) => void;
}

/**
 * Barre d'onglets de la page Espace.
 *
 * Un seul rôle : découper une page qui listait tout à la suite. Les onglets sont
 * construits par l'appelant en fonction des droits, si bien qu'un onglet affiché
 * mène toujours à quelque chose d'utilisable — plutôt qu'à une section vide ou
 * grisée.
 */
export default function Tabs<T extends string>({ tabs, active, onSelect }: TabsProps<T>) {
    return (
        <div className={styles.tabs} role='tablist'>
            {tabs.map((t) => (
                <button
                    key={t.id}
                    type='button'
                    role='tab'
                    aria-selected={t.id === active}
                    className={`${styles.tab} ${t.id === active ? styles.tabActive : ''}`}
                    onClick={() => onSelect(t.id)}
                >
                    <span className={`icon icon-${t.icon}`} />
                    {t.label}
                    {t.badge !== undefined && t.badge > 0 && <span className={styles.tabBadge}>{t.badge}</span>}
                </button>
            ))}
        </div>
    );
}

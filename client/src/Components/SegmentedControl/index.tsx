import styles from './style.module.css';

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    /** Infobulle : ce que le choix recouvre, quand le libellé seul est trop court. */
    title?: string;
    /** Une précision en petit sous le libellé : ce que le choix vaut ici (« Original », puis « 30 i/s »). */
    detail?: string;
}

export interface SegmentedControlProps<T extends string> {
    options: readonly SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    disabled?: boolean;
    /**
     * Étire le groupe sur toute la ligne, chaque choix en prenant une part
     * égale. Pour un contrôle seul sur sa rangée ; dans un formulaire, la
     * largeur naturelle reste la bonne.
     */
    fullWidth?: boolean;
    className?: string;
    'aria-label'?: string;
}

/**
 * Un choix unique parmi deux à quatre options, toutes visibles. Au-delà de
 * quatre, ou pour une liste qui vient des données, `SelectInput` reste le bon
 * outil.
 */
export default function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    disabled,
    fullWidth,
    className,
    'aria-label': ariaLabel
}: SegmentedControlProps<T>) {
    return (
        <div
            className={`${styles.group} ${fullWidth ? styles.fullWidth : ''} ${className ?? ''}`}
            role='group'
            aria-label={ariaLabel}
        >
            {options.map((o) => (
                <button
                    key={o.value}
                    type='button'
                    className={`${styles.segment} ${o.value === value ? styles.active : ''}`}
                    aria-pressed={o.value === value}
                    title={o.title}
                    disabled={disabled}
                    // Recliquer le choix courant ne change rien : le taire évite
                    // à l'appelant un aller-retour (et, sur les permissions, une
                    // écriture et une ligne d'audit) pour un état identique.
                    onClick={() => o.value !== value && onChange(o.value)}
                >
                    {o.label}
                    {o.detail && <span className={styles.detail}>{o.detail}</span>}
                </button>
            ))}
        </div>
    );
}

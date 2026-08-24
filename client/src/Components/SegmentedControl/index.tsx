import styles from './style.module.css';

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    /** Infobulle : ce que le choix recouvre, quand le libellé seul est trop court. */
    title?: string;
}

export interface SegmentedControlProps<T extends string> {
    options: readonly SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    disabled?: boolean;
    className?: string;
    'aria-label'?: string;
}

/**
 * Un choix unique parmi deux à quatre options, toutes visibles.
 *
 * Remplace un menu déroulant quand la liste est courte et connue d'avance : le
 * déroulant cache les choix derrière un clic et pèse lourd pour trois entrées,
 * ici l'état et les alternatives se lisent d'un coup d'œil et se changent d'un
 * clic. Au-delà de quatre options, ou pour une liste qui vient des données,
 * `SelectInput` reste le bon outil.
 */
export default function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    disabled,
    className,
    'aria-label': ariaLabel
}: SegmentedControlProps<T>) {
    return (
        <div className={`${styles.group} ${className ?? ''}`} role='group' aria-label={ariaLabel}>
            {options.map((o) => (
                <button
                    key={o.value}
                    type='button'
                    className={`${styles.segment} ${o.value === value ? styles.active : ''}`}
                    aria-pressed={o.value === value}
                    title={o.title}
                    disabled={disabled}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

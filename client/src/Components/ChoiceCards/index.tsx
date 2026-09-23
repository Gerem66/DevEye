import { useId, type ReactNode } from 'react';

import styles from './style.module.css';

export interface ChoiceCardOption<T extends string> {
    value: T;
    label: string;
    /** Ce que le choix permet et ce qu'il coûte, en une ou deux phrases. */
    description: ReactNode;
    /** Classe d'icône (`icon-lock`…), montrée à côté du libellé. */
    icon?: string;
    /** Un mot en retrait après le libellé, pour désigner le choix conseillé. */
    hint?: ReactNode;
    /** Pourquoi ce choix n'est pas offert ; le rend inerte et s'affiche sous la description. */
    unavailable?: ReactNode;
}

export interface ChoiceCardsProps<T extends string> {
    options: readonly ChoiceCardOption<T>[];
    value: T;
    onChange: (value: T) => void;
    disabled?: boolean;
    /** Le choix en cours d'application : sa carte le signale, les autres attendent. */
    pending?: T | null;
    /**
     * Un clic de pointeur sur une carte, choix courant compris : pour un choix
     * qui fait avancer une étape. Les flèches du clavier changent le choix sans
     * le déclencher.
     */
    onPick?: (value: T) => void;
    'aria-label'?: string;
}

/**
 * Un choix unique dont chaque option s'explique elle-même : une carte par
 * option, libellé et conséquences ensemble. Pour deux ou trois choix qui
 * engagent ; un réglage anodin reste un `SegmentedControl`.
 *
 * La description reste hors du `label` : elle peut porter ses propres éléments
 * cliquables (un terme du glossaire) sans cocher la carte.
 */
export default function ChoiceCards<T extends string>({
    options,
    value,
    onChange,
    disabled,
    pending,
    onPick,
    'aria-label': ariaLabel
}: ChoiceCardsProps<T>) {
    const name = useId();

    return (
        <div className={styles.group} role='radiogroup' aria-label={ariaLabel}>
            {options.map((o) => {
                const inert = disabled || pending != null || o.unavailable != null;
                const descriptionId = `${name}-${o.value}`;
                return (
                    <div
                        key={o.value}
                        className={`${styles.card} ${o.value === value ? styles.active : ''} ${inert ? styles.inert : ''}`}
                        // Le clic que le navigateur rejoue sur la radio (libellé, flèches)
                        // a la radio pour cible : seul le clic d'origine compte ici.
                        onClick={(e) => {
                            if (inert || !onPick) return;
                            if ((e.target as HTMLElement).closest('input, button, a')) return;
                            onPick(o.value);
                        }}
                    >
                        <label className={styles.head}>
                            <input
                                type='radio'
                                className={styles.radio}
                                name={name}
                                checked={o.value === value}
                                disabled={inert}
                                aria-describedby={descriptionId}
                                onChange={() => onChange(o.value)}
                            />
                            <span className={styles.mark} aria-hidden='true' />
                            {o.icon && <span className={`icon ${o.icon} ${styles.icon}`} aria-hidden='true' />}
                            <span className={styles.label}>{o.label}</span>
                            {o.hint && <span className={styles.hint}>{o.hint}</span>}
                            {pending === o.value && <span className={styles.pending}>Application…</span>}
                        </label>
                        <div id={descriptionId} className={styles.description}>
                            {o.description}
                            {o.unavailable != null && <p className={styles.unavailable}>{o.unavailable}</p>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

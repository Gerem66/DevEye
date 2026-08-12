import styles from './style.module.css';

export interface SwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Le libellé. Absent (une ligne qui porte déjà son intitulé), `aria-label`
     *  devient requis — même règle que `Components/Checkbox`. */
    label?: string;
    /** Une ligne d'explication sous le libellé. Ignoré sans libellé. */
    hint?: string;
    /** Choix imposé (ex. l'espace d'appairage d'un appareil) : affiché, non modifiable. */
    disabled?: boolean;
    /** Nécessaire quand il n'y a pas de libellé visible. */
    'aria-label'?: string;
    className?: string;
}

/**
 * Un interrupteur on/off aux couleurs du projet.
 *
 * Un `<button role="switch">` plutôt qu'une case native habillée : contrairement
 * à la case à cocher, il n'y a rien à récupérer du rendu du navigateur ici — pas
 * de coche, pas de forme héritée — et `role="switch"` dit exactement ce que
 * l'objet est. Le clavier (Entrée, Espace) et le focus restent ceux du bouton.
 */
export function Switch({ checked, onChange, label, hint, disabled, className, ...aria }: SwitchProps) {
    return (
        <button
            type='button'
            role='switch'
            aria-checked={checked}
            aria-label={aria['aria-label']}
            disabled={disabled}
            className={`${styles.switch} ${checked ? styles.switchOn : ''} ${
                label !== undefined ? styles.labelled : ''
            } ${className ?? ''}`}
            onClick={() => onChange(!checked)}
        >
            <span className={styles.switchTrack}>
                <span className={styles.switchThumb} />
            </span>
            {label !== undefined && (
                <span className={styles.switchText}>
                    {label}
                    {hint && <span className={styles.switchHint}>{hint}</span>}
                </span>
            )}
        </button>
    );
}

export default Switch;
